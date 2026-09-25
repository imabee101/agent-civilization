# Repository rules for Claude Code

## Git identity and attribution (mandatory)

- Never commit as "Claude". Every commit must be authored and committed as the
  repository owner: `imabee <29169122+imabee101@users.noreply.github.com>`.
- Never add `Co-Authored-By`, `Claude-Session`, "Generated with Claude Code",
  or any other AI attribution line to commit messages, PR titles, or PR bodies.
- Never enable commit signing with a Claude-provided key.
- `.claude/hooks/git-identity.sh` enforces the identity on session start. If a
  commit is ever produced with the wrong author, amend it before pushing.
