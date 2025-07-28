#!/usr/bin/env bash
set -eo pipefail

# Configure Git safe directory
git config --global --add safe.directory /github/workspace

# Navigate to repository root
cd "${GITHUB_WORKSPACE}" || exit 1

CHART_DIR="charts/platform"
CHANGES_DETECTED="false"

# Check if chart files exist
if [[ ! -f "${CHART_DIR}/Chart.yaml" || ! -f "${CHART_DIR}/Chart.lock" ]]; then
  echo "::warning::Chart files missing, nothing to check"
  echo "changes_detected=false" >> "${GITHUB_OUTPUT}"
  exit 0
fi

# Check for changes in chart files
if ! git diff --quiet -- "${CHART_DIR}/Chart.yaml" "${CHART_DIR}/Chart.lock"; then
  CHANGES_DETECTED="true"
fi

echo "changes_detected=${CHANGES_DETECTED}" >> "${GITHUB_OUTPUT}"
