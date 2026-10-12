import { test, expect, targets, type Captain } from "./fixtures.js";

test("guest login, usable lobby and logout", async ({ game }) => {
  const captain = await game.captain("Browser Guest");
  await expect(captain.page.getByText("Online", { exact: true })).toBeVisible();
  await captain.page.getByRole("tab", { name: "Profile", exact: true }).click();
  await expect(captain.page.getByText("Your session cookie is the only key to this account.", { exact: true })).toBeVisible();
  await captain.page.getByRole("button", { name: "Clear Cookie", exact: true }).click();
  await expect(captain.page.getByRole("button", { name: "Start as guest", exact: true })).toBeEnabled();
  await expect(captain.page.getByRole("button", { name: "Start Game", exact: true })).toHaveCount(0);
  captain.allowMissingSession = true;
  await captain.page.reload();
  await expect(captain.page.getByRole("textbox", { name: "Username" })).toBeVisible();
  // A new guest remains usable after clearing the old session.
  await captain.login("Browser New Guest");
});

test("two captains play a full UI match, see both results and return to lobby", async ({ game }) => {
  const [a, b] = await game.pair();
  await a.place();
  await b.place();
  await game.playing(a, b);
  let shots = 0;
  let miss = false;
  while (a.view!.phase !== "finished" && shots < 40) {
    const shooter = a.view!.currentTurnUserId === a.profile!.userId ? a : b;
    const target = miss ? targets.find((target) => shooter.view!.enemyBoard.some((cell) => cell.x === target.x && cell.y === target.y && cell.state === "unknown"))! : { x: 9, y: 9 };
    await shooter.fire(target);
    miss = true;
    shots++;
    await expect.poll(() => a.view?.phase === "finished" || (a.view?.currentTurnUserId === b.view?.currentTurnUserId && a.view?.currentTurnUserId !== shooter.profile!.userId)).toBe(true);
  }
  expect(shots).toBeGreaterThan(17);
  for (const captain of [a, b]) {
    await expect.poll(() => captain.view?.phase).toBe("finished");
    const result = captain.view!.result!;
    expect(result.reason).toBe("ships_sunk");
    await expect(captain.page.getByRole("heading", { name: result.won ? "Fleet Victorious" : "Fleet Lost", exact: true })).toBeVisible();
    await expect(captain.page.getByText("All enemy ships were sunk.", { exact: true })).toBeVisible();
    await expect(captain.page.getByRole("row", { name: "Games Played 1", exact: true })).toBeVisible();
    await expect(captain.page.getByRole("row", { name: `XP Earned ${result.xpEarned}`, exact: true })).toBeVisible();
    await captain.page.getByRole("button", { name: "Back to Lobby", exact: true }).click();
    await captain.lobby();
    const me = await captain.context.request.get(`${game.backend.url}/api/me`);
    expect(me.status()).toBe(200);
    expect((await me.json()).profile.stats.gamesPlayed).toBe(1);
  }
  expect(a.view!.result!.won).not.toBe(b.view!.result!.won);
});

test("connection loss cancels queue and reconnect gives a usable lobby", async ({ game }) => {
  const captain = await game.captain("Browser Queue");
  await captain.page.getByRole("button", { name: "Start Game", exact: true }).click();
  await expect(captain.page.getByText("Searching for an opponent...", { exact: true })).toBeVisible();
  const before = captain.snapshots.length;
  await captain.disconnect();
  await captain.snapshotAfter(before, "lobby");
  await captain.lobby();
  await captain.page.getByRole("button", { name: "Start Game", exact: true }).click();
  await expect(captain.page.getByRole("button", { name: "Cancel Search", exact: true })).toBeEnabled();
  await captain.page.getByRole("button", { name: "Cancel Search", exact: true }).click();
  await captain.lobby();
});

test("placement draft survives reconnect and a running match remains playable", async ({ game }) => {
  const [a, b] = await game.pair();
  await a.place(0, 1);
  const draft = a.page.getByRole("region", { name: "Your placement", exact: true }).locator(".cell-ship");
  // Class inspection verifies the visible painted draft; actions use role/name.
  const beforeDraft = await draft.evaluateAll((cells) => cells.map((cell) => cell.getAttribute("aria-label")));
  expect(beforeDraft).toHaveLength(5);
  const matchId = a.view!.matchId;
  let before = a.snapshots.length;
  await a.disconnect();
  await a.snapshotAfter(before, "match");
  expect(a.view!.matchId).toBe(matchId);
  expect(a.view!.phase).toBe("placing");
  await expect(draft).toHaveCount(5);
  expect(await draft.evaluateAll((cells) => cells.map((cell) => cell.getAttribute("aria-label")))).toEqual(beforeDraft);
  await expect(a.page.getByText("Reconnecting. Waiting for the current server state.", { exact: true })).toHaveCount(0);
  await a.place(1);
  await b.place();
  await game.playing(a, b);
  let shooter: Captain = a.view!.currentTurnUserId === a.profile!.userId ? a : b;
  await shooter.fire(targets[0]);
  await expect.poll(() => a.view?.currentTurnUserId === b.view?.currentTurnUserId && a.view?.currentTurnUserId !== shooter.profile!.userId).toBe(true);
  const boards = a.view!.enemyBoard;
  before = a.snapshots.length;
  await a.disconnect();
  await expect(b.page.getByText("Opponent offline. If they do not reconnect, you win automatically.", { exact: true })).toBeVisible();
  await a.snapshotAfter(before, "match");
  expect(a.view!.matchId).toBe(matchId);
  expect(a.view!.phase).toBe("playing");
  expect(a.view!.enemyBoard).toEqual(boards);
  await expect(b.page.getByText("Opponent offline. If they do not reconnect, you win automatically.", { exact: true })).toHaveCount(0);
  shooter = a.view!.currentTurnUserId === a.profile!.userId ? a : b;
  await shooter.fire(targets[0]); // The other captain's first shot is still unknown.
});

test("backend restart preserves sessions and explicitly removes the stale match", async ({ game }) => {
  const [a, b] = await game.pair();
  await a.place();
  await b.place();
  await game.playing(a, b);
  const oldMatch = a.view!.matchId;
  await game.restart();
  for (const captain of [a, b]) {
    expect(captain.view).toBeUndefined();
    const response = await captain.context.request.get(`${game.backend.url}/api/me`);
    expect(response.status()).toBe(200);
    const profile = (await response.json()).profile;
    expect(profile.userId).toBe(captain.profile!.userId);
    expect(profile.stats.gamesPlayed).toBe(0);
    await captain.page.getByRole("button", { name: "Start Game", exact: true }).click();
  }
  for (const captain of [a, b]) {
    await expect(captain.page.getByRole("region", { name: "Your placement", exact: true })).toBeVisible();
    expect(captain.view!.matchId).not.toBe(oldMatch);
    await expect(captain.page.getByRole("region", { name: "Your placement", exact: true }).locator(".cell-ship")).toHaveCount(0);
    await expect(captain.page.getByRole("button", { name: "Confirm", exact: true })).toBeDisabled();
  }
});
