#!/usr/bin/env bash
set -eo pipefail

REPO_ROOT="$GITHUB_WORKSPACE"

CHART_DIR="$REPO_ROOT/charts/platform"

FAILED_FILE="${GITHUB_WORKSPACE:-/tmp}/failed-charts.csv"

main() {
    local attempt=$1
    cd "${CHART_DIR}"
    
    echo "::group::Helm dependency processing (attempt ${attempt})"
    rm -rf downloaded-charts
    mkdir -p downloaded-charts

    local index=0
    local failed_charts=()
    local dependencies=$(yq e '.dependencies' Chart.yaml -o json)

    while : ; do
        local dep_json=$(echo "${dependencies}" | yq e ".[${index}]" -o json)
        [[ "${dep_json}" == "null" ]] && break

        local name=$(echo "${dep_json}" | yq e '.name' -)
        local repo=$(echo "${dep_json}" | yq e '.repository' -)
        local version=$(echo "${dep_json}" | yq e '.version' -)

        if ! helm pull "${repo}/${name}" --version "${version}" -d downloaded-charts/; then
            echo "::error::Failed to download: ${name}@${version}"
            failed_charts+=("${name},${version}")
        fi
        
        index=$((index + 1))
    done

    echo "::endgroup::"

    if [[ ${#failed_charts[@]} -gt 0 ]]; then
        printf "%s\n" "${failed_charts[@]}" > "${FAILED_FILE}"
        echo "::error::${#failed_charts[@]} charts failed to download"
        return ${#failed_charts[@]}
    fi

    return 0
}

# First argument is attempt number (1 or 2)
main "$1" || {
    exit_code=$?
    # Final attempt should propagate failure
    [[ "$1" -eq 2 ]] && exit ${exit_code}
    exit 0  # First attempt failures are handled by workflow
}
