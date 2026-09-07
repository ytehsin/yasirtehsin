# ZOPE deployment image.
#
# Built on Microsoft's Playwright image rather than plain node:22, because the
# render worker needs a real Chromium and its system libraries. Installing
# those onto a bare Node image means chasing about thirty apt packages
# (libnss3, libatk, libgbm, fonts...) and re-chasing them every Chromium
# update. This image already has them, version-matched to the Playwright
# release in the tag.
#
# Keep the tag's version in step with the playwright version in package.json.
# A mismatch means Playwright looks for a browser build that isn't there, and
# the error it prints does not say so clearly.
FROM mcr.microsoft.com/playwright:v1.48.0-noble

# libreoffice-writer converts .doc, .rtf and .odt uploads to .docx before
# import. It is the largest thing in this image (~400 MB) and it is worth it:
# without it, every author with an older Word file is turned away at the upload
# screen. Note it is libreoffice-writer, not libreoffice — the full suite adds
# Calc, Impress and Base for no benefit here.
#
# Ghostscript is only needed for PDF/X output (IngramSpark and most offset
# printers). Poppler gives you pdftotext, which the render test uses.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-writer ghostscript poppler-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# Dependencies first, as their own layer: they change far less often than the
# code, so a code push rebuilds in seconds instead of minutes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=optional

COPY . .

# Fonts the templates ask for. Without them Chromium silently substitutes,
# pagination shifts, and the page count — and therefore the spine width —
# comes out different from what you tested locally.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-ebgaramond fonts-noto-core fonts-noto-ui-core \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# The image sets PLAYWRIGHT_BROWSERS_PATH itself, so the worker finds Chromium
# without ZOPE_CHROMIUM being set.
CMD ["npx", "tsx", "app/server.ts"]
