export const ACTIONS_JOB_REST_FIXTURE = {
  id: 200,
  run_id: 100,
  name: "test (node 24)",
  status: "completed",
  conclusion: "failure",
  started_at: "2026-01-01T00:00:00Z",
  completed_at: "2026-01-01T00:02:00Z",
  url: "https://api.github.com/repos/cli/cli/actions/jobs/200",
  html_url: "https://github.com/cli/cli/actions/runs/100/job/200",
  steps: [
    {
      number: 1,
      name: "Set up job",
      status: "completed",
      conclusion: "success",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:00:01Z",
    },
    {
      number: 2,
      name: "Run tests",
      status: "completed",
      conclusion: "failure",
      started_at: "2026-01-01T00:00:02Z",
      completed_at: "2026-01-01T00:02:00Z",
    },
  ],
};

// gh run view --log-failed emits tab-delimited job and step columns, then a
// timestamp/message field. gh 2.81 can prefix the first timestamp with a BOM.
export const FAILED_LOG_TAB_DELIMITED_FIXTURE = [
  "test (node 24)\tRun tests\t\uFEFF2026-01-01T00:00:03.000Z # npm test",
  "test (node 24)\tRun tests\t2026-01-01T00:00:04.000Z Error: expected 1 to equal 2",
  "deploy\tPublish\t2026-01-01T00:01:00.000Z Error: publish failed",
].join("\n");
