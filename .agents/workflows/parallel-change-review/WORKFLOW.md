---
name: parallel-change-review
description: Review the entire codebase from the security, performance, and maintainability angles in parallel, consolidate the findings into a decision packet, and gate acceptance on a human approval.
---

Use this workflow to demonstrate a multi-perspective review of a whole codebase.
The reviewers ignore dependency directories, build output, and lock files.

Preconditions:

- Run from the root of the repository that should be reviewed.
- Start the run with `--max-parallel 3` so the independent reviews execute
  concurrently; the default bound of one runs them sequentially.
