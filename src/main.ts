import * as core from '@actions/core'
import {context, GitHub} from '@actions/github'
import {wait} from './wait'


function getPullRequestId(): string {
  const pullRequestId = process.env.GITHUB_REF;

  if (!pullRequestId)
    throw new Error("Action was not triggered by a PR. " +
                    "Use this action with PR triggers.");

  return pullRequestId;
}


async function run(): Promise<void> {
  try {

    const ms: string = core.getInput('milliseconds')
    core.debug(`Waiting ${ms} milliseconds ...`)

    core.debug(new Date().toTimeString())
    await wait(parseInt(ms, 10))
    core.debug(new Date().toTimeString())

    core.setOutput('time', new Date().toTimeString())

    console.log(JSON.stringify(context, null, 4))

    const myToken = core.getInput('myToken');

    const octokit = new GitHub(myToken);
    console.log(octokit);

    // TODO: make a request to get all commits associated with the PR (?)
    const pullRequestId = getPullRequestId();
    console.log(`PR: ${pullRequestId}`);

    const payload = JSON.stringify(context.payload, undefined, 2)
    console.log(`The event payload: ${payload}`);

  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
