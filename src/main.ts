import * as core from '@actions/core'
import {context, GitHub} from '@actions/github'


class NotAPullRequestError extends Error {
  constructor() {
      super('Missing pull request data in the context object. ' +
            'This action must be used with a PR.');
  }
}


function requireValue(callback: () => (string | undefined)): string {
  const value = callback();
  if (!value)
    throw new Error("Missing value");
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
    const owner = requireValue(() => context.payload.owner?.name);
    const repository = requireValue(() => context.payload.repository?.name);

    const pullRequest = context.payload.pull_request;

    if (!pullRequest) {
      throw new NotAPullRequestError();
    }

    await octokit
      .paginate('GET /repos/:owner/:repo/pulls/:pull_number/commits',
      {
        owner: owner,
        repo: repository,
        pull_number: pullRequest.number
      }).then(commits => {

        commits.forEach(item => {
          const issuesIds = getIssuesIdsFromCommitMessage(item.message);

          if (!issuesIds) {
            console.error(`Commit ${item.sha} with message "${item.message}"
            does not refer any issue.
            `)
          }
        });

      })

    // NB: the following method would return only 250 commits
    // const commitsResponse = await octokit.pulls.listCommits();


    // const messages = commits.map(item => item.commit.message);

  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
