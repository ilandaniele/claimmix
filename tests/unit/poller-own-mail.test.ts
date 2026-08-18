/**
 * Not reading our own outgoing mail back in.
 *
 * gmail history.list reports every change in the mailbox, SENT included — only
 * the fallback list paths filter on labelIds: ["INBOX"]. Three seconds after
 * answering a claimant the poller ingested our own reply as an inbound
 * message, attached it to the case, and re-extraction — now reading a thread
 * made of two of our own templates — classified the claim as no_relevante.
 */

vi.mock("@/server/email/gmail/accounts", () => ({
  getGmailAccountByEmail: vi.fn(),
  listEnabledGmailAccounts: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getGmailAccountByEmail } from "@/server/email/gmail/accounts";
import { isOwnMailbox } from "@/server/email/gmail/gmail-poller";

const mocked = getGmailAccountByEmail as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe("isOwnMailbox", () => {
  it("recognises a reply we sent, display name and all", async () => {
    mocked.mockResolvedValue({ id: "a", email: "ilan.daniele@gmail.com", enabled: true });

    expect(await isOwnMailbox("ClaimMix <ilan.daniele@gmail.com>")).toBe(true);
    expect(mocked).toHaveBeenCalledWith("ilan.daniele@gmail.com");
  });

  it("matches a bare address and ignores casing", async () => {
    mocked.mockResolvedValue({ id: "a", email: "x@y.com", enabled: true });
    expect(await isOwnMailbox("  ILAN.Daniele@Gmail.com ")).toBe(true);
    expect(mocked).toHaveBeenCalledWith("ilan.daniele@gmail.com");
  });

  it("lets a real claimant through", async () => {
    mocked.mockResolvedValue(null);
    expect(await isOwnMailbox("Ilan Daniele <idaniele@blueboot.com>")).toBe(false);
  });

  it("lets the message through when the lookup fails", async () => {
    // A duplicated message is recoverable; a dropped claim is not.
    mocked.mockRejectedValue(new Error("db down"));
    expect(await isOwnMailbox("someone@elsewhere.com")).toBe(false);
  });

  it("treats a missing From header as not ours", async () => {
    expect(await isOwnMailbox("")).toBe(false);
    expect(mocked).not.toHaveBeenCalled();
  });
});
