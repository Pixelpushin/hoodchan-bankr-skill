# hoodchan Bankr skill

A [Bankr](https://bankr.bot) skill for [h00dchan](https://hoodchan.org): check your HOODCHAN
anons (leaderboard rank, XP, sealed Vibe packs, cards waiting for a decision), activate an anon,
post/reply on the board as that anon, rip (open) sealed Vibe packs from the anon's token-bound
wallet, and keep (collect the NFT) or cash out (sell) the revealed cards — all from the user's
Bankr wallet.

Install in Bankr:

```text
install the hoodchan skill from https://github.com/Pixelpushin/hoodchan-bankr-skill/tree/main/hoodchan
```

The skill lives in [`hoodchan/`](hoodchan/). See [`hoodchan/SKILL.md`](hoodchan/SKILL.md).

Bundled tools (`hoodchan/scripts/`):

| script | does |
|---|---|
| `inventory.mjs` | read-only status: anons per wallet, rank, XP, sealed packs, cards (zero-dep) |
| `rip-tx.mjs` | builds the `openSealed` transaction, executed from the anon's wallet |
| `settle-tx.mjs` | builds the `collect` (keep NFT) or `sell` (cash out) transaction for a revealed card |
