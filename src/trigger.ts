import { Octokit } from '@octokit/core';
import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';

interface WorkflowMap {
  [key: string]: string;
}

interface WorkflowRun {
  id: number;
  created_at: string;
  workflow_id: number;
  status: string;
  conclusion: string | null;
}

interface WorkflowData {
  path: string;
  id: number;
}

const POLL_INTERVAL = 30000; // 30 seconds
const MAX_WAIT = 3600000; // 1 hour
const WORKFLOW_FILE = 'rc-next-release.yaml';
const ORG_NAME = 'Alaffia-Technology-Solutions';
const WORKFLOW_MAP: WorkflowMap = {
  "alaffia": "alaffia-apps",
  "ask-autodor": "alaffia-apps",
  "fdw": "fdw",
  "reports": "reports",
  "gpt-search": "gpt-search",
  "document-api": "document-api",
  "autodor-py": "autodor-py",
  "file-api": "file-api",
  "graphql": "graphql_api",
  "agent-flows": "gpt-search"
};

// Parse services to deploy from environment
const SERVICES_TO_DEPLOY: string[] = process.env.SERVICES_TO_DEPLOY 
  ? process.env.SERVICES_TO_DEPLOY.split(',').map(s => s.trim()).filter(Boolean)
  : [];

function shouldDeployService(serviceName: string): boolean {
  // If no services specified, deploy all
  if (SERVICES_TO_DEPLOY.length === 0) {
    return true;
  }
  
  // Check if service is in the deployment list
  return SERVICES_TO_DEPLOY.includes(serviceName);
}

// Add validation function
function validateServices(): void {
  if (SERVICES_TO_DEPLOY.length === 0) return;
  
  const validServices = Object.keys(WORKFLOW_MAP);
  const invalidServices = SERVICES_TO_DEPLOY.filter(s => !validServices.includes(s));
  
  if (invalidServices.length > 0) {
    core.warning(`⚠️ Unknown services requested: ${invalidServices.join(', ')}`);
    core.info(`ℹ️ Valid services are: ${validServices.join(', ')}`);
  }
}

async function waitForWorkflowCompletion(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number,
  expectedWorkflowId: number
): Promise<void> {
  const startTime = Date.now();
  let lastStatus = '';
  
  while (Date.now() - startTime < MAX_WAIT) {
    const { data: run } = await octokit.request(
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}',
      { owner, repo, run_id: runId }
    ) as { data: WorkflowRun };

    if (run.workflow_id !== expectedWorkflowId) {
      throw new Error(`Workflow ID changed! Expected ${expectedWorkflowId}, got ${run.workflow_id}`);
    }

    if (run.status !== lastStatus) {
      core.info(`🔄 ${repo} workflow status: ${run.status}`);
      lastStatus = run.status;
    }

    if (run.status === 'completed') {
      if (run.conclusion === 'success') {
        core.info(`✅ ${repo} workflow completed successfully`);
        return;
      }
      throw new Error(`❌ ${repo} workflow failed with conclusion: ${run.conclusion}`);
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
  
  throw new Error(`🕛 ${repo} workflow timed out after ${MAX_WAIT/60000} minutes`);
}

async function triggerWorkflows(failedCharts: string[]): Promise<void> {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  // Validate requested services
  validateServices();

  // Phase 1: Deduplicate and trigger workflows
  core.info('\n🚀 Starting workflow triggering');
  
  // Get unique target repositories
  const targetRepos = [...new Set(
    failedCharts
      .map(chartLine => {
        const [name] = chartLine.split(',');
        
        // Check if this service should be deployed
        if (!shouldDeployService(name)) {
          core.info(`⏩ Skipping ${name} (not in deployment list)`);
          return null;
        }
        
        return WORKFLOW_MAP[name || ''] || null;
      })
      .filter(Boolean)
  )] as string[];

  if (targetRepos.length === 0) {
    core.info('⏩ No valid repositories to trigger');
    if (SERVICES_TO_DEPLOY.length > 0) {
      core.info(`📝 Services requested: ${SERVICES_TO_DEPLOY.join(', ')}`);
    }
    return;
  }

  core.info(`📦 Target repositories: ${targetRepos.join(', ')}`);
  if (SERVICES_TO_DEPLOY.length > 0) {
    core.info(`📝 Deploying only selected services: ${SERVICES_TO_DEPLOY.join(', ')}`);
  }

  // Trigger workflows for unique repos
  const triggerPromises = targetRepos.map(async (targetRepo) => {
    const triggerTime = new Date().toISOString();
    core.info(`⚡ Triggering ${targetRepo} at ${triggerTime}`);

    try {
      await octokit.request(
        'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches',
        {
          owner: ORG_NAME,
          repo: targetRepo,
          workflow_id: WORKFLOW_FILE,
          ref: process.env.BRANCH_NAME!,
          inputs: { branch: process.env.BRANCH_NAME! }
        }
      );
      return { targetRepo, triggerTime };
    } catch (error) {
      core.error(`🔥 Failed to trigger ${targetRepo}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  });

  const triggeredWorkflows = await Promise.allSettled(triggerPromises);

  // Phase 2: Find triggered runs
  core.info('\n🔍 Searching for triggered runs');
  const runPromises = triggeredWorkflows
    .filter((result): result is PromiseFulfilledResult<{ targetRepo: string; triggerTime: string }> => 
      result.status === 'fulfilled'
    )
    .map(async ({ value }) => {
      const { targetRepo, triggerTime } = value;
      let attempts = 0;
      const MAX_ATTEMPTS = 10;
      const RETRY_DELAY = 10000;

      core.info(`🔎 Looking for ${targetRepo} run triggered after ${triggerTime}`);
      
      while (attempts < MAX_ATTEMPTS) {
        try {
          const { data: runs } = await octokit.request(
            'GET /repos/{owner}/{repo}/actions/runs',
            {
              owner: ORG_NAME,
              repo: targetRepo,
              event: 'workflow_dispatch',
              per_page: 5
            }
          ) as { data: { workflow_runs: WorkflowRun[] } };

          const newRun = runs.workflow_runs.find(r => 
            new Date(r.created_at) >= new Date(triggerTime)
          );

          if (newRun) {
            core.info(`✅ Found ${targetRepo} run #${newRun.id}`);
            return { targetRepo, run: newRun };
          }
        } catch (error) {
          core.error(`⚠️ Error finding ${targetRepo} run: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }

        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        attempts++;
      }
      throw new Error(`❌ ${targetRepo}: Run not found after ${MAX_ATTEMPTS} attempts`);
    });

  const runResults = await Promise.allSettled(runPromises);

  // Phase 3: Validate workflows
  core.info('\n🔐 Validating workflow paths');
  const validationPromises = runResults
    .filter((result): result is PromiseFulfilledResult<{ targetRepo: string; run: WorkflowRun }> => 
      result.status === 'fulfilled'
    )
    .map(async ({ value }) => {
      const { targetRepo, run } = value;
      
      try {
        const { data: workflow } = await octokit.request(
          'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}',
          {
            owner: ORG_NAME,
            repo: targetRepo,
            workflow_id: run.workflow_id
          }
        ) as { data: WorkflowData };

        const expectedPath = `.github/workflows/${WORKFLOW_FILE}`;
        if (workflow.path !== expectedPath) {
          throw new Error(`🚨 Invalid workflow path: ${workflow.path} (expected ${expectedPath})`);
        }

        core.info(`✔️ ${targetRepo} workflow path validated`);
        return { targetRepo, run, workflowId: workflow.id };
      } catch (error) {
        core.error(`💣 Validation failed for ${targetRepo}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
      }
    });

  const validatedRuns = await Promise.allSettled(validationPromises);

  // Phase 4: Monitor all workflows
  core.info('\n👀 Starting workflow monitoring');
  const monitoringPromises = validatedRuns
    .filter((result): result is PromiseFulfilledResult<{ targetRepo: string; run: WorkflowRun; workflowId: number }> => 
      result.status === 'fulfilled'
    )
    .map(({ value }) => {
      const { targetRepo, run, workflowId } = value;
      
      return waitForWorkflowCompletion(
        octokit,
        ORG_NAME,
        targetRepo,
        run.id,
        workflowId
      )
      .then(() => core.info(`🎉 ${targetRepo} completed successfully`))
      .catch(error => {
        core.error(`💥 ${targetRepo} failed: ${error.message}`);
        throw error;
      });
    });

  const monitoringResults = await Promise.allSettled(monitoringPromises);

  // Check for any failures
  const failures = monitoringResults.filter(r => r.status === 'rejected');
  if (failures.length > 0) {
    const errorMessages = failures
      .map(f => (f as PromiseRejectedResult).reason.message)
      .join('\n- ');
    throw new Error(`🚨 ${failures.length} workflow(s) failed:\n- ${errorMessages}`);
  }

  core.info('\n✅ All workflows completed successfully');
}

async function loadFailedCharts(): Promise<string[]> {
  try {
    const filePath = path.join(process.env.GITHUB_WORKSPACE || '', 'failed-charts.csv');
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n').filter(line => line.trim());
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function main(): Promise<void> {
  try {
    const failedData = await loadFailedCharts();
    if (failedData.length > 0) {
      core.info(`📄 Found ${failedData.length} failed chart(s)`);
      await triggerWorkflows(failedData);
    } else {
      core.info('✅ No failed charts to process');
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`🚨 Critical error: ${error.message}`);
    } else {
      core.setFailed('🚨 Unknown error occurred');
    }
    process.exit(1);
  }
}

main().catch(error => {
  if (error instanceof Error) {
    core.error(`💣 Unhandled error: ${error.stack || error.message}`);
  }
  process.exit(1);
});
