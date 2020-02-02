import * as core from '@actions/core'
import {context, GitHub} from '@actions/github'


class NotAPullRequestError extends Error {
  constructor() {
      super('Missing pull request data in the context object. ' +
            'This action must be used with a PR.');
  }
}


function requireValue(callback: () => (string | undefined), hint: string): string {
  const value = callback();
  if (!value)
    throw new Error(`Missing value for ${hint}`);
  return value;
}


function getIssuesIdsFromCommitMessage(message: string): (string[] | null) {
  if (message.indexOf('#') == -1)
    return null;

  const match = message.match(/(#\d+)/g);

  if (!match)
    return null;
  return match;
}


async function run(): Promise<void> {
  try {
    const octokit = new GitHub(core.getInput('myToken'));
    const owner = requireValue(() => context.payload.repository?.owner?.login, 'owner');
    const repository = requireValue(() => context.payload.repository?.name, 'repository');

    const pullRequest = context.payload.pull_request;

    if (!pullRequest) {
      throw new NotAPullRequestError();
    }

    try {
    // NOTA BENE: the following fails with message
    // "##[error]fatal: couldn't find remote ref refs/pull/1/merge"
    await octokit
      .paginate('GET /repos/:owner/:repo/pulls/:pull_number/commits',
      {
        owner: owner,
        repo: repository,
        pull_number: pullRequest.number
      }).then(commits => {

        // console.log('0: -------------------------------------------');
        // console.log('1: commits response');
        // console.log(JSON.stringify(commits, null, 2));

        // NB: funny return payload; a list of commits are items with commit property
        commits.forEach(item => {
          const issuesIds = getIssuesIdsFromCommitMessage(item.commit.message);

          if (!issuesIds) {
            console.error(`Commit ${item.sha} with message "${item.commit.message}"
            does not refer any issue.
            `)
          } else {
            console.info(`ids: ${issuesIds}`)
          }
        });

      })
    } catch (error) {
      console.log(`Method 0 does not work, fail with message: ${error.message}`)
    }

    try {
    // NB: the following method would return only 250 commits
    const commitsResponse = await octokit.pulls.listCommits({
      owner: owner,
      repo: repository,
      pull_number: pullRequest.number
    });
    console.log('1: -------------------------------------------');
    console.log(JSON.stringify(commitsResponse, null, 2));
  } catch (error) {
    console.log(`Method 1 does not work, fail with message: ${error.message}`)
  }

  try {
    const response = await octokit.request('GET /repos/:owner/:repo/pulls/:pull_number/commits',
    {
      owner,
      repo: repository,
      pull_number: pullRequest.number
    });
    const data = response.data;
    console.log('2: -------------------------------------------');
    console.log(JSON.stringify(data, null, 2));
    // const messages = commits.map(item => item.commit.message);
  } catch (error) {
    console.log(`Method 2 does not work, fail with message: ${error.message}`)
  }
  } catch (error) {
    core.setFailed(error.message)
  }

  core.setFailed("Forced failure")
}

run()
