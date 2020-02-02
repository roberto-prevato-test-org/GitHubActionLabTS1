import * as core from '@actions/core'
import { context, GitHub } from '@actions/github'
import { PullsGetResponseLabelsItem } from '@octokit/rest';
import { WebhookPayload } from '@actions/github/lib/interfaces';


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


async function getPullRequestLabels(
  octokit: GitHub,
  owner: string,
  repo: string,
  pull_number: number
): Promise<PullsGetResponseLabelsItem[]> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number
  });

  return response.data.labels
}


function skipValidation(labels: PullsGetResponseLabelsItem[]): boolean {
  for (var i = 0; i < labels.length; i++) {
    let label = labels[i];
    if (label.name == "skip-issue") {
      return true;
    }
  }
  return false;
}


function shouldTriggerPreviousChecks(payload: WebhookPayload): boolean {
  return payload.action == 'labeled' || payload.action == 'unlabeled';
}


async function run(): Promise<void> {
  let anyMissing = false;

  try {
    // console.log(`The context: ${JSON.stringify(context, undefined, 2)}`);
    // console.log('\n\n\n\n\n')

    const octokit = new GitHub(core.getInput('myToken'));
    const owner = requireValue(() => context.payload.repository?.owner?.login, 'owner');
    const repository = requireValue(() => context.payload.repository?.name, 'repository');

    const pullRequest = context.payload.pull_request;

    if (!pullRequest) {
      throw new NotAPullRequestError();
    }

    if (shouldTriggerPreviousChecks(context.payload)) {
      // this action is fired when a PR labels change;
      // since GitHub creates a new check, pass this one and force a re-check of
      // previously failed checks
      const pr_commit_sha = requireValue(() => context.payload.pull_request?.head.sha,
                                         'pr_head_sha');

      // Test: get all check suites
      const all_check_suites = await octokit.checks.listSuitesForRef({
        owner,
        repo: repository,
        ref: pr_commit_sha
      })

      // console.log(`all_check_suites: ${JSON.stringify(all_check_suites, undefined, 2)}`);
      // console.log('\n\n\n\n\n')

      console.log('Forcing a re-check of previous checks');

      for (var i = 0; i < all_check_suites.data.check_suites.length; i++) {
        let checkSuite = all_check_suites.data.check_suites[0];
        if (checkSuite.status == 'completed') {
          await octokit.checks.rerequestSuite({
            owner,
            repo: repository,
            check_suite_id: checkSuite.id
          })
        }
      }
      return;
    }

    const labels = await getPullRequestLabels(octokit, owner, repository, pullRequest.number);

    if (skipValidation(labels)) {
      console.log("Commit messages validation skipped by label (skip-issue)");
      return;
    }

    try {
      // NB: paginate fetches all commits for the PR, so it handles
      // the unlikely situation of a PR with more than 250 commits
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
                anyMissing = true;
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

    // TODO: get all commits that do not reference any issue
    // TODO: download issues and check their ids

    /*
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
    */
  } catch (error) {
    core.setFailed(error.message)
  }

  if (anyMissing) {
    core.setFailed("Some commit messages do not refer any issue.")
  }
}

run()
