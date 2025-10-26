// ----------------------------------------------------------------------------
// Copyright (c) Ben Coleman, 2020
// Licensed under the MIT License.
//
// Workflow Dispatch Action - Main task code
// ----------------------------------------------------------------------------

import * as core from '@actions/core'
import * as github from '@actions/github'
import * as PackageJSON from '../package.json'

type Workflow = {
  id: number
  name: string
  path: string
}

//
// Main task function (async wrapper)
//
async function run(): Promise<void> {
  core.info(`🏃 Workflow Dispatch Action v${PackageJSON.version}`)
  try {
    // Required inputs
    const workflowRef = core.getInput('workflow')

    // Optional inputs, with defaults
    const token = core.getInput('token')
    const ref = core.getInput('ref') || github.context.ref
    const [owner, repo] = core.getInput('repo')
      ? core.getInput('repo').split('/')
      : [github.context.repo.owner, github.context.repo.repo]

    // Decode inputs, this MUST be a valid JSON string
    let inputs = {}
    const inputsJson = core.getInput('inputs')
    if (inputsJson) {
      inputs = JSON.parse(inputsJson)
    }

    // Get octokit client for making API calls
    const octokit = github.getOctokit(token)

    // List workflows via API, and handle paginated results
    const workflows: Workflow[] = await octokit.paginate(
      octokit.rest.actions.listRepoWorkflows.endpoint.merge({
        owner,
        repo,
      }),
    )

    // Debug response if ACTIONS_STEP_DEBUG is enabled
    core.debug('### START List Workflows response data')
    core.debug(JSON.stringify(workflows, null, 3))
    core.debug('### END:  List Workflows response data')

    // Locate workflow either by name, id or filename
    const foundWorkflow = workflows.find((workflow) => {
      return (
        workflow.name === workflowRef ||
        workflow.id.toString() === workflowRef ||
        workflow.path.endsWith(`/${workflowRef}`) ||
        workflow.path == workflowRef
      )
    })

    if (!foundWorkflow) throw new Error(`Unable to find workflow '${workflowRef}' in ${owner}/${repo} 😥`)

    console.log(`🔎 Found workflow, id: ${foundWorkflow.id}, name: ${foundWorkflow.name}, path: ${foundWorkflow.path}`)

    // Call workflow_dispatch API
    console.log('🚀 Calling GitHub API to dispatch workflow...')
    const dispatchResp = await octokit.request(
      `POST /repos/${owner}/${repo}/actions/workflows/${foundWorkflow.id}/dispatches`,
      {
        ref: ref,
        inputs: inputs,
      },
    )

    core.info(`🏆 API response status: ${dispatchResp.status}`)
    core.setOutput('workflowId', foundWorkflow.id)

    // Wait for the workflow to start (it might take a few seconds)
    console.log('⌛ Waiting for workflow run to start...')
    let workflowRun = null
    let attempts = 0
    const maxAttempts = 30 // 30 attempts * 2 second delay = 60 seconds max wait time

    while (!workflowRun && attempts < maxAttempts) {
      const runsResponse = await octokit.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: foundWorkflow.id,
        branch: ref.replace('refs/heads/', ''),
        per_page: 1,
      })

      const latestRun = runsResponse.data.workflow_runs[0]
      if (latestRun && new Date(latestRun.created_at) > new Date(Date.now() - 60000)) {
        workflowRun = latestRun
        console.log(`📋 Workflow run started with ID: ${workflowRun.id}`)
      } else {
        await new Promise(resolve => setTimeout(resolve, 2000)) // Wait 2 seconds before checking again
        attempts++
      }
    }

    if (!workflowRun) {
      throw new Error('Timed out waiting for workflow run to start')
    }

    // Wait for the workflow run to complete
    console.log('⏳ Waiting for workflow run to complete...')
    while (workflowRun.status !== 'completed') {
      const runResponse: any = await octokit.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: workflowRun.id,
      })
      workflowRun = runResponse.data

      if (workflowRun.status !== 'completed') {
        await new Promise(resolve => setTimeout(resolve, 5000)) // Check every 5 seconds
      }
    }

    // Set outputs for the workflow run status and conclusion
    core.setOutput('workflow_run_id', workflowRun.id)
    core.setOutput('workflow_run_status', workflowRun.status)
    core.setOutput('workflow_run_conclusion', workflowRun.conclusion)
    console.log(`✨ Workflow run completed with conclusion: ${workflowRun.conclusion}`)

  } catch (error) {
    const e = error as Error

    if (e.message.endsWith('a disabled workflow')) {
      core.warning('Workflow is disabled, no action was taken')
      return
    }

    core.setFailed(e.message)
  }
}

//
// Call the main task run function
//
run()
