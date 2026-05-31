import { useState } from "react";
import { hitRate, type PlayerProfile } from "@pixelfleet/shared";
import {
  EightBitAvatar,
  EightBitBadge,
  EightBitButton,
  EightBitProgress,
  EightBitSeparator,
  EightBitTable,
  EightBitTabs,
  EightBitTooltip
} from "./8bit";

export function Lobby({
  profile,
  connected,
  onStart,
  onLogout
}: {
  profile: PlayerProfile;
  connected: boolean;
  onStart: () => void;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState("lobby");
  const nextLevelTotal = profile.xpForNextLevel - profile.xpForCurrentLevel;
  const progress = nextLevelTotal > 0 ? (profile.xpIntoLevel / nextLevelTotal) * 100 : 100;

  return (
    <main className="app-screen lobby-screen">
      <section className="pixel-panel lobby-hero">
        <EightBitAvatar seed={profile.avatarSeed} label={profile.username} size="lg" />
        <div className="player-heading">
          <p className="eyebrow">Captain</p>
          <h1>{profile.username}</h1>
          <div className="badge-row">
            <EightBitBadge tone="success">Level {profile.level}</EightBitBadge>
            <EightBitBadge tone={connected ? "info" : "warning"}>{connected ? "Online" : "Reconnect..."}</EightBitBadge>
          </div>
        </div>
        <EightBitTooltip label="XP is stored on the server after every match.">
          <div className="xp-panel">
            <EightBitProgress
              value={progress}
              label={`${profile.xpIntoLevel} / ${nextLevelTotal} XP to Level ${profile.level + 1}`}
            />
          </div>
        </EightBitTooltip>
        <EightBitButton size="lg" disabled={!connected} onClick={onStart}>
          Start Game
        </EightBitButton>
      </section>

      <section className="pixel-panel lobby-panel">
        <EightBitTabs
          active={tab}
          onChange={setTab}
          tabs={[
            { id: "lobby", label: "Lobby" },
            { id: "stats", label: "Stats" },
            { id: "profile", label: "Profile" }
          ]}
        />
        <EightBitSeparator />
        {tab === "lobby" ? <StatsCards profile={profile} /> : null}
        {tab === "stats" ? (
          <EightBitTable
            rows={[
              { label: "Wins", value: profile.stats.wins },
              { label: "Losses", value: profile.stats.losses },
              { label: "Games Played", value: profile.stats.gamesPlayed },
              { label: "Shots Fired", value: profile.stats.shotsFired },
              { label: "Hits", value: profile.stats.hits },
              { label: "Ships Sunk", value: profile.stats.shipsSunk },
              { label: "Hit Rate", value: `${hitRate(profile.stats)}%` }
            ]}
          />
        ) : null}
        {tab === "profile" ? (
          <div className="profile-note">
            <p>Guest account: {profile.userId.slice(0, 8)}</p>
            <p>Your session cookie is the only key to this account.</p>
            <EightBitButton variant="ghost" onClick={onLogout}>
              Clear Cookie
            </EightBitButton>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function StatsCards({ profile }: { profile: PlayerProfile }) {
  const stats = [
    ["Wins", profile.stats.wins],
    ["Losses", profile.stats.losses],
    ["Games", profile.stats.gamesPlayed],
    ["Hit Rate", `${hitRate(profile.stats)}%`]
  ];

  return (
    <div className="stats-grid">
      {stats.map(([label, value]) => (
        <div className="stat-card" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}
