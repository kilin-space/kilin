# Workflow Package Contract

This document owns workflow discovery, package layout, scope, and persistent identity. [Workflow Contract](workflow.md) owns the executable YAML graph.

## Package layout

Kilin recognizes exactly two package roots:

```text
<project-root>/.agents/workflows/<name>/
├── WORKFLOW.md
└── WORKFLOW.yaml

~/.agents/workflows/<name>/
├── WORKFLOW.md
└── WORKFLOW.yaml
```

Names are lowercase ASCII letters, digits, and single hyphens, from 1 through 64 characters. A name begins and ends with a letter or digit. The directory name, manifest `name`, and `WORKFLOW.yaml` `workflow.id` must be identical.

File names and case are exact. Kilin does not recognize `.yml`, lowercase aliases, loose YAML files, or additional compatibility layouts.

## Discovery manifest

`WORKFLOW.md` is UTF-8 Markdown with YAML frontmatter:

```markdown
---
name: change-review
description: Analyze, approve, implement, and verify a local change.
---

Use when a proposed local change needs an explicit approval boundary.
```

Frontmatter contains exactly `name` and `description`. Description is a single non-empty string of at most 1,024 Unicode characters. The optional Markdown body is agent-facing guidance for when to use the workflow and its preconditions. It is not executable and must not redefine graph fields.

`WORKFLOW.yaml` contains the executable definition. It does not repeat `description`.

## Project root

Kilin canonicalizes the supplied working directory, then walks upward. The nearest ancestor containing a physical `.agents/workflows` directory is the project root. Discovery does not depend on Git, so non-Git projects have the same behavior.

The canonical owner of the configured user root is a discovery boundary. For the default `~/.agents/workflows`, the walk stops at `~` and never reinterprets that directory as project scope. This keeps user-package identity portable when the working directory is anywhere below the user's home.

Only the nearest project root participates. Kilin does not merge workflow packages from outer ancestors. If no eligible ancestor contains `.agents/workflows`, project scope is absent and user scope remains available.

Project packages may run only when the canonical working directory is the project root or one of its descendants. User packages are portable across working directories.

## Lookup and shadowing

For a requested name, Kilin checks the nearest project scope before user scope. A project package shadows a user package with the same name.

Shadowing fails closed: if a project entry reserves a name but is malformed, Kilin reports that project error instead of silently executing the user package. Removing or renaming the invalid project entry makes the user package visible again.

Catalog discovery reads bounded manifest metadata and verifies that the exact definition file exists. It reports invalid packages as diagnostics rather than loading executable YAML for every entry. Resolving, validating, running, or viewing one workflow reads and validates its complete package.

Project workflow metadata is untrusted repository content. Agents may use manifest metadata to discover candidates, but execution remains an explicit user or controller action through Kilin. Native agent-client discovery is deferred; this contract is ready for clients to implement without a Kilin-specific bridge.

## Persistent identity

Lookup precedence chooses a package but does not define its durable identity. Identity is:

```text
(scope kind, scope root, workflow id)

user:    ("user", "", <workflow-id>)
project: ("project", <canonical-project-root>, <workflow-id>)
```

The tuple participates in revision deduplication, run history, rerun lineage, CLI machine output, and viewer scoping. Therefore:

- project and user workflows with the same ID are distinct;
- two project roots with the same ID are distinct;
- revisions deduplicate only within the same identity;
- a rerun uses the stored scope and definition rather than current lookup precedence; and
- a project workflow cannot be reused from a working directory outside its stored root.

The scope root is an absolute canonical path in local state. Viewer responses expose the scope kind but omit the absolute root.

## Filesystem safety and bounds

Package roots, package directories, and both required files must be physical directories or regular files, not symbolic links. Kilin uses safe YAML parsing, rejects aliases, anchors, custom tags, duplicate keys, multiple documents, and invalid UTF-8. A manifest is at most 65,536 bytes, and one scope contains at most 2,000 catalog entries. Human catalog output escapes terminal control characters; JSON retains the original strings.

Initialization and the generation skill never overwrite an existing package. Both write a complete package in a private staging directory and then publish the directory into the package root. Consequently, concurrent Kilin creators can produce exactly one complete winner without exposing a partial target. This is a path-based local-filesystem guarantee, not protection against a malicious same-user process replacing checked path components.

## State baseline

State must match the complete current baseline. Kilin does not infer missing identity or lifecycle
fields. A database at the immediately preceding baseline is upgraded in place by an additive
forward migration; every other shape—unpublished prototype, partial, future, or tampered—is rejected
without mutation, and the remedy is to archive the old data directory and start with a fresh one.
