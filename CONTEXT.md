# pi-gh context

This package gives pi a compact, reliable interface to GitHub through the authenticated `gh` CLI.

## Language

**Resource target**:
A GitHub URL, repository-qualified identifier, or current-checkout reference that identifies one repository, issue, pull request, workflow run, release, or related GitHub resource.
_Avoid_: URL argument, repo selector, locator

**Capability loader**:
The always-active pi tool that finds and enables the smallest relevant set of GitHub operation tools.
_Avoid_: Tool router, dispatcher, search tool

**Operation tool**:
A lazily enabled pi tool with a strict schema for one coherent family of GitHub actions.
_Avoid_: gh wrapper, command tool

**Projection**:
The compact, resource-specific result returned to the model, with optional explicit expansion for more fields or detail.
_Avoid_: Summary, raw output, formatted response

**Write**:
A GitHub operation that changes data or triggers work. Pi or its harness applies any permission policy.
_Avoid_: Mutation command, destructive action
