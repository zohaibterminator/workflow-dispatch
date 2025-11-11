import * as core from '@actions/core'
import * as github from '@actions/github'
import * as PackageJSON from '../package.json'

type Workflow = {
  id: number
  name: string
  path: string
}

async function triggerAndWaitForWorkflow(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  workflowRef: string,
  ref: string,
  inputs: Record<string, any>
) {
  const workflows: Workflow[] = await octokit.paginate(
    octokit.rest.actions.listRepoWorkflows.endpoint.merge({ owner, repo })
  )

  const foundWorkflow = workflows.find(
    (w) =>
      w.name === workflowRef ||
      w.id.toString() === workflowRef ||
      w.path.endsWith(`/${workflowRef}`) ||
      w.path === workflowRef
  )

  if (!foundWorkflow) throw new Error(`Unable to find workflow '${workflowRef}' in ${owner}/${repo}`)

  core.info(`Dispatching workflow '${foundWorkflow.name}'...`)

  await octokit.request(`POST /repos/${owner}/${repo}/actions/workflows/${foundWorkflow.id}/dispatches`, {
    ref,
    inputs,
  })

  // Wait until it starts
  let workflowRun = null
  let attempts = 0
  while (!workflowRun && attempts < 30) {
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
    } else {
      await new Promise((r) => setTimeout(r, 2000))
      attempts++
    }
  }

  if (!workflowRun) throw new Error(`Timed out waiting for ${foundWorkflow.name} to start`)

  // Wait until it completes
  while (workflowRun.status !== 'completed') {
    const runResponse: any = await octokit.rest.actions.getWorkflowRun({
      owner,
      repo,
      run_id: workflowRun.id,
    })
    workflowRun = runResponse.data
    if (workflowRun.status !== 'completed') {
      await new Promise((r) => setTimeout(r, 5000))
    }
  }

  core.info(`✅ Workflow '${foundWorkflow.name}' completed with conclusion: ${workflowRun.conclusion}`)
  return {
    id: workflowRun.id,
    name: foundWorkflow.name,
    status: workflowRun.status,
    conclusion: workflowRun.conclusion,
  }
}

async function run(): Promise<void> {
  core.info(`Workflow Dispatch Action v${PackageJSON.version}`)
  try {
    const workflowInput = core.getInput('workflow') // Can be one or many
    const workflowRefs = workflowInput.includes(',')
      ? workflowInput.split(',').map((s: any) => s.trim())
      : [workflowInput]

    const token = core.getInput('token')
    const ref = core.getInput('ref') || github.context.ref
    const [owner, repo] = core.getInput('repo')
      ? core.getInput('repo').split('/')
      : [github.context.repo.owner, github.context.repo.repo]

    // Parse global or per-workflow inputs
    let inputsMap: Record<string, any> = {}
    const inputsJson = core.getInput('inputs')
    if (inputsJson) inputsMap = JSON.parse(inputsJson)

    const octokit = github.getOctokit(token)
    const results = []

    for (const wf of workflowRefs) {
      const wfInputs =
        typeof inputsMap[wf] === 'object' && inputsMap[wf] !== null
          ? inputsMap[wf]
          : inputsMap // fallback to global inputs if none specific

      const res = await triggerAndWaitForWorkflow(octokit, owner, repo, wf, ref, wfInputs)
      results.push(res)
    }

    core.setOutput('workflows_results', JSON.stringify(results, null, 2))
  } catch (error) {
    const e = error as Error
    if (e.message.endsWith('a disabled workflow')) {
      core.warning('Workflow is disabled, no action was taken')
      return
    }
    core.setFailed(e.message)
  }
}

run()
