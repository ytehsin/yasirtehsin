# Getting this on GitHub

```bash
# 1. Unpack wherever you keep projects
unzip zope-core.zip && cd zope-core

# 2. Install and confirm it works before you commit anything
npm install
npx playwright install chromium     # only needed for the render worker
npm test                            # detection + round-trip, both should be 20/20

# 3. Make it a repo
git init -b main
git add .
git commit -m "Book Project model, template engine, render and import pipelines"

# 4. Create the remote and push
gh repo create zope-core --private --source=. --push
```

No `gh` CLI? Create an empty repo on github.com (no README, no .gitignore —
this repo already has one), then:

```bash
git remote add origin git@github.com:<you>/zope-core.git
git push -u origin main
```

## Commit the fixtures

`test/fixtures/*.docx` are 260 KB total and they are the test corpus, not build
output. They are deliberately not in `.gitignore`. Without them in the repo, CI
cannot run and a contributor cannot tell whether their change to detection made
things better or worse.

## What CI does

`.github/workflows/ci.yml` runs on every push and pull request:

- `npm run test:detect` — 20 fixtures, chapter and part counts against ground truth
- `npm run test:roundtrip` — exact body-word conservation through import
- `npm run typecheck`

Both test scripts exit non-zero on failure, so a change that improves one
manuscript and breaks four cannot merge. Turn on branch protection for `main`
requiring the `ci` check, or the gate is advisory only.

## Private vs public

Keep it private for now. The detection heuristics and the token architecture
are the parts of ZOPE that took thought, and there is no benefit to publishing
them before you have customers.

If you later open-source parts of it, the template token format is the natural
candidate — an open template spec lets designers build for you.
