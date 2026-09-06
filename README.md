# The web app

One page and four endpoints, no framework. Upload a Word file, check the
chapters ZOPE found, correct anything wrong, and download a typeset PDF or a
reflowable EPUB.

```bash
npm install
npx playwright install chromium     # first time only
npm run dev                          # http://localhost:4000
```

## What it does

`GET  /`            the page
`POST /api/import`  .docx in, detected chapter list out
`POST /api/render`  corrected blocks in, print-ready PDF out
`POST /api/epub`    the same blocks, as a reflowable EPUB 3
`GET  /api/papers`  paper stocks for the spine calculation

Both export routes run the same corrected blocks through the same serializer
and differ only in stylesheet. That is the architecture's central claim, and
having the two buttons side by side is what makes it checkable rather than
merely asserted.

## What is deliberately missing

No accounts, no saved projects, no payment, no cover designer, no ISBN, and no
rights declaration. Projects live in a `Map` in memory and are dropped after an
hour. Every one of those is a product decision, and putting a placeholder in
now would only have to be torn out later.

The rights declaration in particular should be built before anyone but you
uploads a manuscript. It is half a day of work and it is the difference between
a platform that has a defensible position on copyright and one that does not.

## Hosting it

This needs a Node server with Chromium available — roughly 1 GB of memory
during a render. Static hosting (GitHub Pages, Netlify, plain Vercel) cannot
run it at all.

Workable options, cheapest first: a small VPS (DigitalOcean, Hetzner, ~$6/mo),
Railway, Render, or Fly.io. On any of them, install the Playwright browser as
part of the build step, not at runtime.

Rendering a long book takes minutes and holds a browser process the whole time.
The first thing to change when real users arrive is moving renders to a job
queue so a slow book cannot block the server — the `Map` in `server.ts` is the
line where that change begins.
