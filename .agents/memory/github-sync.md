---
name: GitHub sync
description: Safe synchronization approach for the Ricky repository and starter workspace
---

The Ricky GitHub repository can have a complete application history even when the local workspace starts from a separate scaffold history. Syncing requires explicitly connecting the remote, fetching first, and preserving the starter commit before adopting the repository's main branch.

**Why:** A normal pull may fail with either “no remote” or “divergent branches,” and resolving that blindly can discard the working app or local assets.

**How to apply:** Keep user-uploaded assets outside the sync commit, make a backup branch before reconciling unrelated histories, and verify both the frontend preview and API after dependencies and the development database schema are ready. For HTTPS pushes, use Git-compatible Basic auth with a securely stored token; a Bearer header can be rejected even when the token has repository write permission.