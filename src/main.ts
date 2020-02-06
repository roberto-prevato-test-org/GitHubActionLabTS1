import * as core from '@actions/core'
import { context, GitHub } from '@actions/github'
import {
  PullsGetResponseLabelsItem
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


function getIssuesIdsFromText(
  text: (string | undefined | null)
): (string[] | null) {
  if (!text || text.indexOf('#') == -1)
    return null;

  const match = text.match(/(#\d+)/g);

  if (!match)
    return null;
  return match;
}


function mergeArrays<T>(...arrays: (T[] | null)[]) : (T[] | null)
{
  let values: (T[] | null) = null;
  for (const array of arrays) {
    if (array === null)
      continue;
    if (values == null)
      values = [];
    values = values.concat(array);
  }
  return values;
}


function distinct<T>(array: T[]) : T[] {
  return array.filter((item, index, self) => self.indexOf(item) === index);
}


function emptyOrNull<T>(array: (T[] | null)) : boolean {
  return array == null || array.length == 0;
}


function getIssuesIdsFromPullRequestProperties(
  pullRequest: WebhookPayload["pull_request"]
): (string[] | null) {
  if (!pullRequest) {
    throw new NotAPullRequestError();
  }

  return mergeArrays(
    getIssuesIdsFromText(pullRequest.title),
    getIssuesIdsFromText(pullRequest.body)
  );
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


async function getIssueIdsFromCommitMessages(
  octokit: GitHub,
  owner: string,
  repo: string,
  pull_number: number
): Promise<string[]> {
    var issueIds: string[] = [];

    // NB: paginate fetches all commits for the PR, so it handles
    // the unlikely situation of a PR with more than 250 commits
    await octokit
      .paginate('GET /repos/:owner/:repo/pulls/:pull_number/commits',
        {
          owner,
          repo,
          pull_number
        }
      )
      .then(items => {
        items.forEach(item => {
          const issuesIds = getIssuesIdsFromText(item.commit.message);

          if (!issuesIds) {
            console.error(`Commit ${item.sha} with message "${item.commit.message}"
                           does not refer any issue.`)
          }
        });
      })

  return distinct(issueIds);
}


function getPositiveCommentBody(distinctIssuesIds: string[]): string {
  if (!distinctIssuesIds.length)
    throw new Error('Expected a populated array of issues ids.');

  let emojis = ':sparkles: :cake: :sparkles:';

  if (distinctIssuesIds.length == 1)
    return `Great! The PR references this issue: ${distinctIssuesIds[0]} ${emojis}`;

  return `Great! The PR references these issues: ${distinctIssuesIds.join(', ')} ${emojis}`
}


async function run(): Promise<void> {
  try {
    const octokit = new GitHub(core.getInput('myToken'));
    const owner = requireValue(() => context.payload.repository?.owner?.login, 'owner');
    const repo = requireValue(() => context.payload.repository?.name, 'repository');

    // TODO:
    // 1. look for issue ids in PR title and body
    // 2. support by action configuration to look for issue ids in both comments and PR
    // console.log(`context: ${JSON.stringify(context, null, 2)}\n-------`);

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
    const labels = await getPullRequestLabels(octokit, owner, repo, pullRequest.number);

    if (skipValidation(labels)) {
      console.log("`Link to issue` validation skipped by label (skip-issue)");
      return;
    }

    let issuesIdsInPullRequest = getIssuesIdsFromPullRequestProperties(pullRequest);

    if (emptyOrNull(issuesIdsInPullRequest)) {
      // TODO: throw exception, require the PR to be edited (?)
      // TODO: get issue ids from commit messages, too? (looks overcomplicated)
      throw new Error("The pull request doesn't reference any issue.");
    }

    if (issuesIdsInPullRequest == null)
      throw new Error('Program flow error: issues ids must be present here.');

    // add comment to PR
    // NB: this is a code comment!! But it looks like there is no API to post
    // a regular timeline comment on a PR (???)
    const firstCommit = await octokit.pulls.listCommits({
      owner,
      repo,
      pull_number: pullRequest.number
    }).then(response => response.data.length ? response.data[0] : null);

    if (firstCommit == null)
      // this should be impossible
      throw new Error('The PR doesn`t have any commit.');

    await octokit.issues.createComment({
      owner,
      repo,
      body: getPositiveCommentBody(distinct(issuesIdsInPullRequest)),
      issue_number: pullRequest.number
    });
    /*
    // NB: the following can only create a comment related to a commit!
    await octokit.pulls.createComment({
      owner,
      repo,
      body: getPositiveCommentBody(distinct(issuesIdsInPullRequest)),
      pull_number: pullRequest.number,
      commit_id: pullRequest.head.sha,
      path: firstCommit.commit.url
    });
    */
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
