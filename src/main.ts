import * as core from '@actions/core'
import { context, GitHub } from '@actions/github'
import {
  PullsGetResponseLabelsItem, IssuesGetResponse
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


function getIdsFromText(
  text: (string | undefined | null)
): (string[] | null) {
  if (!text || text.indexOf('#') == -1)
    return null;

  const match = text.match(/(#\d+)/g);

  if (!match)
    return null;
  return match;
}


function mergeArrays<T>(...arrays: (T[] | null)[]): (T[] | null) {
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


function distinct<T>(array: T[]): T[] {
  return array.filter((item, index, self) => self.indexOf(item) === index);
}


function emptyOrNull<T>(array: (T[] | null)): boolean {
  return array == null || array.length == 0;
}


function getIdsFromPullRequestProperties(
  pullRequest: WebhookPayload["pull_request"]
): (string[] | null) {
  if (!pullRequest) {
    throw new NotAPullRequestError();
  }

  return mergeArrays(
    getIdsFromText(pullRequest.title),
    getIdsFromText(pullRequest.body)
  );
}


async function getIssuesFromPullRequestProperties(
  octokit: GitHub,
  owner: string,
  repo: string,
  pullRequest: WebhookPayload["pull_request"]
): Promise<IssuesGetResponse[]> {
  const idsInPullRequest = getIdsFromPullRequestProperties(pullRequest);
  const values: IssuesGetResponse[] = [];

  if (emptyOrNull(idsInPullRequest))
    return values;

  if (idsInPullRequest == null)
    throw new Error('Expected a value');

  for (const id in distinct(idsInPullRequest)) {
    const issueNumber = Number(id.replace('#', ''));

    if (isNaN(issueNumber)) {
      // NB: issue number is expected to be a string with leading # and followed by \d+
      // if this happens, it's a program error
      throw new Error(`Invalid id: ${id}; cannot parse as number. Expected #\d+`)
    }

    let data: (IssuesGetResponse | null) = null;
    try {
      await octokit.issues.get({
        owner,
        repo,
        issue_number: issueNumber
      }).then(response => {
        data = response.data;
      });
    } catch (error) {
      console.log(JSON.stringify(error, null, 2))
      if (error.message == 'Not Found') {
        // this is fine; not all ids must refer an issues
        console.log(`An issue with id: '${id}' was not found.`);
      } else {
        throw error;
      }
    }

    if (data) {
      values.push(data);
    }
  }

  return values;
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


async function getIdsFromCommitMessages(
  octokit: GitHub,
  owner: string,
  repo: string,
  pull_number: number
): Promise<string[]> {
  var ids: string[] = [];

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
        const commitIds = getIdsFromText(item.commit.message);

        if (commitIds) {
          ids = ids.concat(commitIds);
        }
      });
    })

  return distinct(ids);
}


function getPositiveCommentBody(issues: IssuesGetResponse[]): string {
  if (!issues.length)
    throw new Error('Expected a populated array of issues.');

  const emojis = ':sparkles: :cake: :sparkles:';
  const distinctIssuesIds = distinct(issues.map(item => item.id));

  if (distinctIssuesIds.length == 1)
    return `Great! The PR references this issue: ${distinctIssuesIds[0]} ${emojis}`;

  return `Great! The PR references these issues: ${distinctIssuesIds.join(', ')} ${emojis}`
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
    const labels = await getPullRequestLabels(octokit, owner, repo, pullRequest.number);

    if (skipValidation(labels)) {
      console.log("`Link to issue` validation skipped by label (skip-issue)");
      return;
    }

    let issuesIdsInPullRequest = await getIssuesFromPullRequestProperties(
      octokit,
      owner,
      repo,
      pullRequest
    );

    if (!issuesIdsInPullRequest.length) {
      throw new Error("The pull request doesn't reference any issue.");
    }

    if (issuesIdsInPullRequest == null)
      throw new Error('Program flow error: issues ids must be present here.');

    await octokit.issues.createComment({
      owner,
      repo,
      body: getPositiveCommentBody(issuesIdsInPullRequest),
      issue_number: pullRequest.number
    });

  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
