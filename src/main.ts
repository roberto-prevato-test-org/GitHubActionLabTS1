import * as core from '@actions/core'
import { context, GitHub } from '@actions/github'
import {
  PullsGetResponseLabelsItem,
  ChecksListSuitesForRefResponse
} from '@octokit/rest';
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


// NB: the following function doesn't do what we thought it would do!
async function runAllChecks(
  octokit: GitHub,
  owner: string,
  repo: string,
  suites: ChecksListSuitesForRefResponse
): Promise<void> {

  // console.log(`all_check_suites: ${JSON.stringify(suites, undefined, 2)}`);
  // console.log('\n\n\n\n\n')

  for (const checkSuite of suites.check_suites) {
    try {
      await octokit.checks.rerequestSuite({
        owner,
        repo,
        check_suite_id: checkSuite.id
      })
    } catch (error) {
      console.log(`Failed to run check suite ${checkSuite.id}: ${error.message}`);
    }
  }
}


async function markPreviousRunsAsNeutral(
  octokit: GitHub,
  owner: string,
  repo: string
) {
  const ref = requireValue(() => context.payload.pull_request?.head.sha, 'pr_head_sha');

  const suitesResponse = await octokit.checks.listSuitesForRef({
    owner,
    repo,
    ref
  })

  const suites = suitesResponse.data;

  // keep only check suites for github-actions app
  let githubActionsSuites = suites.check_suites
    .filter(item => item.app.name == 'GitHub Actions')

  for (const checkSuite of githubActionsSuites) {
    let runsResponse = await octokit.checks.listForSuite({
      check_suite_id: checkSuite.id,
      owner,
      repo
    });

    if (runsResponse.data.total_count > 250) {
      // TODO: support this scenario
      throw new Error('More than 250 check runs are not supported');
    }

    let checkCommitsMessageRuns = runsResponse.data.check_runs
      .filter(item => item.name == 'Check Commit Messages'
                      && item.status == 'completed');

    if (!checkCommitsMessageRuns.length) {
      continue;
    }

    for (const checkCommitsMessageRun of checkCommitsMessageRuns) {
      await octokit.checks.update({
        check_run_id: checkCommitsMessageRun.id,
        owner,
        repo,
        conclusion: 'neutral'
      });
    }
  }
}


function skipValidation(labels: PullsGetResponseLabelsItem[]): boolean {
  for (const label of labels) {
    if (label.name == "skip-issue") {
      return true;
    }
  }
  return false;
}


function isChangeOfLabel(payload: WebhookPayload): boolean {
  return payload.action == 'labeled' || payload.action == 'unlabeled';
}


async function handleChangeOfLabel(
  octokit: GitHub,
  owner: string,
  repo: string
): Promise<void> {
  const ref = requireValue(() => context.payload.pull_request?.head.sha, 'pr_head_sha');

  const suitesForRef = await octokit.checks.listSuitesForRef({
    owner,
    repo,
    ref
  })

  // TODO: the following is the wrong strategy
  // console.log('Forcing a re-check of previous checks');
  // await runAllChecks(octokit, owner, repo, suitesForRef.data);

  return;
}


async function run(): Promise<void> {
  try {
    const octokit = new GitHub(core.getInput('myToken'));
    const owner = requireValue(() => context.payload.repository?.owner?.login, 'owner');
    const repo = requireValue(() => context.payload.repository?.name, 'repository');

    const pullRequest = context.payload.pull_request;

    if (!pullRequest) {
      throw new NotAPullRequestError();
    }

    // start by marking previous check runs of the same type neutral
    // they are not relevant anymore, because a new run is happening in the same suite
    // re-running the suite wouldn't help because a suite is considered to be running
    // even if a single new check run is happening
    await markPreviousRunsAsNeutral(octokit, owner, repo);

    // if the pull request has the skip-issue label, this check is skipped,
    // and previous runs are marked as neutral
    const labels = await getPullRequestLabels(octokit, owner, repo, pullRequest.number);

    if (skipValidation(labels)) {
      console.log("Commit messages validation skipped by label (skip-issue)");
      return;
    }

    // NB: paginate fetches all commits for the PR, so it handles
    // the unlikely situation of a PR with more than 250 commits
    await octokit
      .paginate('GET /repos/:owner/:repo/pulls/:pull_number/commits',
        {
          owner,
          repo,
          pull_number: pullRequest.number
        }
      )
      .then(items => {
        var anyMissing = false;

        items.forEach(item => {
          const issuesIds = getIssuesIdsFromCommitMessage(item.commit.message);

          if (!issuesIds) {
            anyMissing = true;
            console.error(`Commit ${item.sha} with message "${item.commit.message}"
                           does not refer any issue.`)
          } else {
            console.info(`ids: ${issuesIds}`)
          }
        });

        if (anyMissing) {
          throw new Error("One or more commit messages don't refer any issue.");
        }
      })
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
