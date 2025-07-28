#!/bin/bash

# Check if argument is provided
if [ -z "$1" ]; then
    echo "Error: Version argument is required"
    echo "Usage: $0 <version>"
    exit 1
fi

## Example usage: 
## ./platform-get-versions-from-service.sh 1-4-0

NEXT_VERSION="$1"

# Convert version format from 1-4-0 to 1.4.0
CHART_VERSION=$(echo "$NEXT_VERSION" | tr '-' '.')

REPO_ROOT="$GITHUB_WORKSPACE"
PLATFORM_CHART_PATH="$REPO_ROOT/charts/platform/Chart.yaml"

# Verify Chart.yaml exists
if [[ ! -f "$PLATFORM_CHART_PATH" ]]; then
    echo "::error::Chart.yaml not found at $PLATFORM_CHART_PATH"
    exit 1
fi


# Update the platform chart version
echo "Updating Platform Chart version to $CHART_VERSION-next"
yq -i ".version = \"$CHART_VERSION-next-$SHORT_SHA\"" "$PLATFORM_CHART_PATH"

# Initialize CHANGED_REPOS as an empty array
CHANGED_REPOS=()

# Parse services to deploy
if [ -n "$SERVICES_TO_DEPLOY" ]; then
    IFS=',' read -ra SELECTED_SERVICES <<< "$SERVICES_TO_DEPLOY"
    echo "Selected services to deploy: ${SELECTED_SERVICES[@]}"
else
    SELECTED_SERVICES=()
    echo "No specific services selected, will process all services with matching branches"
fi

# Function to check if a service should be deployed
should_deploy_service() {
    local service=$1
    
    # If no services specified, deploy all
    if [ ${#SELECTED_SERVICES[@]} -eq 0 ]; then
        return 0
    fi
    
    # Check if service is in the selected list
    for selected in "${SELECTED_SERVICES[@]}"; do
        if [ "$service" == "$selected" ]; then
            return 0
        fi
    done
    
    return 1
}

# Fetch repos with matching branches
for repo in $(gh repo list alaffia-Technology-Solutions --json name -q '.[].name'); do
  if ! [[ $NEXT_VERSION =~ ^[0-9]+-[0-9]+-[0-9]+$ ]]; then
    echo "Error: Version must match pattern: digits-digits-digits (e.g. 1-0-0)"
    exit 1
  fi
  # Debug: Print the output of the gh api command
  echo "Fetching branches for repo: $repo"
  branches=$(gh api repos/alaffia-Technology-Solutions/"$repo"/branches --paginate --jq '.[] | select(.name == "platform-'"$NEXT_VERSION"'") | .name')
  echo "Branches found: $branches"
  if [ -n "$branches" ]; then
    if should_deploy_service "$repo"; then
      CHANGED_REPOS+=("$repo")
      echo "✓ Service $repo will be deployed"
    else
      echo "✗ Service $repo skipped (not in deployment list)"
      continue
    fi
    for branch in $branches; do
      echo "Checking $repo:$branch"
      chart_version=$(gh api repos/alaffia-Technology-Solutions/"$repo"/contents/chart/Chart.yaml?ref="$branch" --jq '.content' | base64 --decode | grep '^version:' | awk '{print $2}' 2>/dev/null)
      if [ -n "$chart_version" ]; then
        echo "$repo:$branch:chart: $chart_version"
      else
        product_folders=$(gh api repos/alaffia-Technology-Solutions/"$repo"/contents/charts?ref="$branch" --jq '.[] | select(.type == "dir") | .name' 2>/dev/null)
        for product in $product_folders; do
          chart_version=$(gh api repos/alaffia-Technology-Solutions/"$repo"/contents/charts/"$product"/Chart.yaml?ref="$branch" --jq '.content' | base64 --decode | grep '^version:' | awk '{print $2}' 2>/dev/null)
          if [ -n "$chart_version" ]; then
            echo "$repo:$branch:charts/$product: $chart_version"
          fi
        done
      fi
    done
  fi
done

# Update platform chart dependencies
echo -e "\nUpdating Platform Chart dependencies..."
for repo in "${CHANGED_REPOS[@]}"; do
    echo "Processing repo: $repo"
    chart_version=$(gh api repos/alaffia-Technology-Solutions/"$repo"/contents/chart/Chart.yaml?ref=platform-"$NEXT_VERSION" --jq '.content' | base64 --decode | grep '^version:' | awk '{print $2}' 2>/dev/null)
    if [ -n "$chart_version" ]; then
        if [ "$repo" = "graphql_api" ]; then
            echo "Updating graphql dependency to version: $chart_version"
            yq -i ".dependencies[] |= select(.name == \"graphql\") .version = \"$chart_version\"" "$PLATFORM_CHART_PATH"
        else
            echo "Updating $repo dependency to version: $chart_version"
            yq -i ".dependencies[] |= select(.name == \"$repo\") .version = \"$chart_version\"" "$PLATFORM_CHART_PATH"
        fi
        continue
    fi
    product_folders=$(gh api repos/alaffia-Technology-Solutions/"$repo"/contents/charts?ref=platform-"$NEXT_VERSION" --jq '.[] | select(.type == "dir") | .name' 2>/dev/null)
    for product in $product_folders; do
        chart_version=$(gh api repos/alaffia-Technology-Solutions/"$repo"/contents/charts/"$product"/Chart.yaml?ref=platform-"$NEXT_VERSION" --jq '.content' | base64 --decode | grep '^version:' | awk '{print $2}')
        if [ -n "$chart_version" ]; then
            echo "Updating $product dependency to version: $chart_version"
            yq -i ".dependencies[] |= select(.name == \"$product\") .version = \"$chart_version\"" "$PLATFORM_CHART_PATH"
        fi
    done
done

# Verify the updated Chart.yaml
echo -e "\nUpdated Platform Chart:"
cat "$PLATFORM_CHART_PATH" | yq '.dependencies[] | [.name, .version] | @tsv'
