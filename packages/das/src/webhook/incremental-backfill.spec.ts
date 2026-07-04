import {
  needsContentRefresh,
  needsMetadataRefresh,
  StoredPrState,
} from "./incremental-backfill";

const stored = (over: Partial<StoredPrState> = {}): StoredPrState => ({
  headSha: "head1",
  baseSha: "base1",
  updatedAt: "2026-06-01T00:00:00Z",
  scoringDataStored: true,
  ...over,
});

describe("needsContentRefresh", () => {
  it("skips when content is stored and both SHAs are unchanged", () => {
    expect(needsContentRefresh(stored(), "head1", "base1")).toBe(false);
  });

  it("re-fetches a brand-new PR (no stored row)", () => {
    expect(needsContentRefresh(null, "head1", "base1")).toBe(true);
    expect(needsContentRefresh(undefined, "head1", "base1")).toBe(true);
  });

  it("re-fetches when content was never stored", () => {
    expect(
      needsContentRefresh(
        stored({ scoringDataStored: false }),
        "head1",
        "base1",
      ),
    ).toBe(true);
  });

  it("re-fetches when the head SHA moved", () => {
    expect(needsContentRefresh(stored(), "head2", "base1")).toBe(true);
  });

  it("re-fetches when the base SHA moved (base branch advanced)", () => {
    expect(needsContentRefresh(stored(), "head1", "base2")).toBe(true);
  });

  it("treats stored-null and incoming-null SHAs as equal (deleted head)", () => {
    expect(
      needsContentRefresh(stored({ headSha: null, baseSha: null }), null, null),
    ).toBe(false);
  });
});

describe("needsMetadataRefresh", () => {
  it("skips when updatedAt is unchanged", () => {
    expect(needsMetadataRefresh(stored(), "2026-06-01T00:00:00Z")).toBe(false);
  });

  it("re-fetches when updatedAt moved", () => {
    expect(needsMetadataRefresh(stored(), "2026-06-02T00:00:00Z")).toBe(true);
  });

  it("re-fetches a brand-new PR (no stored row)", () => {
    expect(needsMetadataRefresh(null, "2026-06-01T00:00:00Z")).toBe(true);
  });

  it("re-fetches when the stored updatedAt is null (historic row)", () => {
    expect(
      needsMetadataRefresh(stored({ updatedAt: null }), "2026-06-01T00:00:00Z"),
    ).toBe(true);
  });

  it("re-fetches when GitHub returned a null updatedAt", () => {
    expect(needsMetadataRefresh(stored(), null)).toBe(true);
  });

  // Stored side is a hydrated Date, incoming is GitHub's ISO string.
  it("skips when a hydrated Date equals GitHub's ISO string (same instant)", () => {
    expect(
      needsMetadataRefresh(
        stored({ updatedAt: new Date("2026-06-01T00:00:00Z") }),
        "2026-06-01T00:00:00Z",
      ),
    ).toBe(false);
  });

  it("skips across timezone-equivalent representations of the same instant", () => {
    expect(
      needsMetadataRefresh(
        stored({ updatedAt: new Date("2026-06-01T00:00:00Z") }),
        "2026-05-31T19:00:00-05:00",
      ),
    ).toBe(false);
  });

  it("re-fetches when a hydrated Date is a different instant", () => {
    expect(
      needsMetadataRefresh(
        stored({ updatedAt: new Date("2026-06-01T00:00:00Z") }),
        "2026-06-02T00:00:00Z",
      ),
    ).toBe(true);
  });

  it("re-fetches (fails safe) on an unparseable stored value", () => {
    expect(
      needsMetadataRefresh(
        stored({ updatedAt: "not-a-date" }),
        "2026-06-01T00:00:00Z",
      ),
    ).toBe(true);
  });
});
