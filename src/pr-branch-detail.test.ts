import { describe, expect, test } from "bun:test"

import { mapGhPrBranchDetail, mapSyncedPrBranchDetail } from "./pr-branch-detail.ts"

describe("PR branch detail mappers", () => {
  test("normalizes daemon and sync sources to the same contract", () => {
    const longBody = "x".repeat(510)
    const fromDaemon = mapGhPrBranchDetail({
      reviewDecision: "CHANGES_REQUESTED",
      requestedReviewers: [{ login: "reviewer" }, {}],
      comments: [{ id: 1 }, { id: 2 }],
      reviews: [
        {
          state: "CHANGES_REQUESTED",
          author: { login: "author" },
          body: longBody,
        },
      ],
      mergeable: "MERGEABLE",
    })
    const fromSync = mapSyncedPrBranchDetail(
      {
        reviewDecision: "CHANGES_REQUESTED",
        requestedReviewers: [{ login: "reviewer" }, {}],
        mergeable: "MERGEABLE",
      },
      [{ id: 1 }, { id: 2 }],
      [
        {
          state: "CHANGES_REQUESTED",
          user: { login: "author" },
          body: longBody,
        },
      ]
    )

    expect(fromDaemon).toEqual(fromSync)
    expect(fromDaemon.changesRequestedReviews[0]?.body).toHaveLength(500)
  })

  test("supplies stable defaults for missing source fields", () => {
    expect(mapGhPrBranchDetail({})).toEqual({
      reviewDecision: "",
      requestedReviewers: [],
      commentCount: 0,
      changesRequestedReviews: [],
      mergeable: "UNKNOWN",
    })
    expect(mapSyncedPrBranchDetail({}, null, null)).toEqual(mapGhPrBranchDetail({}))
  })
})
