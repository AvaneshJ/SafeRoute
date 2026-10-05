const INVITE_LINK = /^(?:https?:\/\/[^/]+)?\/invite\/?(\?[^#]*)?/i;

/** Maps https://<hosting>/invite?inviteId=…&token=… App Links onto the invite screen. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  const match = INVITE_LINK.exec(path);
  return match ? `/GuardianInvite${match[1] ?? ""}` : path;
}
