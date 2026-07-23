# KCMPS — Conversion-First Storefront Redesign

A static HTML/CSS/vanilla-JS SPA redesigned to apply Alex Hormozi's "no-brainer offer" principles. Visitors land on an optimized persuasion funnel before browsing the catalog. Cart system with two payment paths: immediate SKU purchases and custom requests billed after approval. Migration-ready architecture — all logic is data-driven and shaped exactly like a future API response.

## What's New

### 1. Hormozi Conversion-First Flow

The entire page structure is reordered around a **dream outcome + single obvious CTA**:

1. **Offer Hero** — "Your design, printed on a premium shirt — from ₱170"
   - Price anchor tied to real DTF pricing (₱50 transfer + ₱120 shirt press = ₱170)
   - 3-item value checklist (free file prep, reprint guarantee, in-house production)
   - Trust chips (guarantee, no minimums, custom pay-after-approval)

2. **Value Stack** — itemized inclusions with peso values
   - Free file check & prep (₱150)
   - Free layout assistance (₱200)
   - Reprint-free guarantee (premium feature)
   - Struck-through total value vs. actual price paid

3. **Guarantee Band** — risk reversal
   - "Love it, or we reprint it — free" (owner-editable)
   - Dark navy background with translucent overlay + glassy blur

4. **How It Works** — 3-step flow
   - Pick or upload a design
   - We produce in-house
   - Pickup or delivery

5. **Storefront** — 9-leaf catalog with real product cards + custom-request cards
   - Pre-designed SKU items (DTF: 3 priced designs at ₱50/80/120)
   - Every leaf includes a "Custom design request" card (₱0 now, billed after approval)
   - Size selector, shirt press toggle, qty stepper, live price updates

6. **Cart** — slide-in drawer with two-path checkout
   - SKU items show price and subtotal
   - Custom requests show "₱0 now / Pending approval — billed after design review"
   - Checkout captures: name, contact, fulfillment (pickup/delivery), notes
   - Composes order summary and sends to configured endpoint (default: `mailto:`)

7. **FAQ** — objection handling
   - File formats, turnaround, payment timing, approval process, pickup vs. delivery

8. **Estimator** — repositioned as "Bulk & custom" helper for larger runs

9. **Mission/Vision & Contact** — brand story and location info below the store

### 2. Cart System (Frontend-Only, Migration-Ready)

#### `website/products.js`

Single source of truth for catalog data. Shaped exactly like a future API response so backend migration is a one-line swap:

```javascript
window.KCMPS_STORE_DATA = {
  currency: "₱",
  shirtAddon: { id: "shirt", label: "Press onto a shirt (+₱120)", price: 120 },
  leaves: {
    "dtf": { customLabel: "Custom design request", ... },
    // ... 8 more leaves (subli, hotmelt, 3dprint, souvenir, network, storage, entertainment, print-office)
  },
  products: [
    // 3 DTF pre-made SKU products with real size pricing
    { id: "dtf-street-statement", leaf: "dtf", type: "sku", 
      variants: [{label:"2×3 in", price:50}, {label:"A4", price:80}, {label:"A3", price:120}],
      shirtAddon: true },
    // ...
  ]
}
```

**To add a new priced product:** copy an entry, give it a unique `id`, assign the correct `leaf`, and set `variants` or a single `price`.

**To enable a "coming soon" leaf:** add priced `products` entries for that leaf; the custom-request card is automatically appended.

#### `website/store.js`

Cart logic, rendering, and checkout:

- **`addToCart(item)`** — add SKU or custom request
- **`setQty(key, qty)`** — update line-item quantity
- **`removeItem(key)`** — remove from cart
- **`payNowTotal()`** — sum of priced (SKU) items
- **`pendingCount()`** — count of custom requests pending approval
- **`renderCatalog()`** — populates each `[data-products-leaf="..."]` container with product cards + custom-request card
- **`renderCart()`** — builds the drawer UI (line items, subtotals, checkout form)
- **`submitOrder()`** — captures form data and sends to `CHECKOUT_ENDPOINT`
- **`window.KCMPS_STORE = { open, close, refreshBadge }`** — public API for auth integration

**Data persistence:** `localStorage` key `kcmps_cart`. Survives page reloads.

**Guard for auth-popup mode:** exits early if `document.documentElement.classList.contains("auth-popup")`, preventing storefront JS from running in OAuth flow.

**Checkout target:** configurable `CHECKOUT_ENDPOINT` constant at top. Default is `mailto:` to the business owner with order summary. To integrate a real payment/form endpoint:

```javascript
const CHECKOUT_ENDPOINT = 'https://form-service.com/api/orders'; // or Formspree/Web3Forms URL
// Then in submitOrder(), replace the mailto link with a fetch() call
```

### 3. Hero Carousel

**4 images** auto-advancing right-to-left with a slow, continuous drift:

1. Original KCMPS studio workspace (existing)
2. `hero-2.png` — Heat press applying DTF transfer to shirt (AI-generated)
3. `hero-3.png` — Customer holding finished print (AI-generated)
4. `hero-4.png` — Designer's desk with DTF film, laptop, folded shirts (AI-generated)

**Auto-advance timing:**
- 4-second slow scroll transition (smooth, noticeable motion)
- 1.5-second pause before the next slide begins
- Total interval: 5.5 seconds per slide

**Controls:**
- **Left/right arrows** (translucent-navy, 40px circles) — manual navigation
- **Dot indicators** (bottom center, 4 dots) — jump to specific slide
- **Touch swipe** — right-to-left swipe advances, left-to-right goes back
- **Hover/focus** — autoplay pauses while the user is looking
- **`prefers-reduced-motion`** — autoplay disabled, manual controls still work

### 4. Page Background Texture

`website/assets/bg-texture.png` — light watercolor-wash texture (cream/white with navy ink-wash vignette at edges, matching brand color `#1d3f72`).

**Applied to `body`:**
- `background-image: url('assets/bg-texture.png')`
- `background-size: cover`
- `background-attachment: fixed` — parallax effect, doesn't scroll with content

**Surface treatment for legibility:**
- **`.card`** cards: `rgba(236, 238, 242, 0.82)` + `backdrop-filter: blur(6px)` — frosted glass
- **Guarantee band**: `92%` opacity navy + `backdrop-filter: blur(8px)` — stays dark, texture shows faintly
- **`--color-bg` token**: `rgba(246, 247, 249, 0.92)` — slightly transparent, texture bleeds through
- **`--color-surface` token**: `rgba(236, 238, 242, 0.9)` — for inherited backgrounds
- **Nav**: existing `backdrop-filter: blur(10px)` + translucent background — no change
- **Form inputs & cart drawer**: solid backgrounds — readability-critical

## Architecture

### Tech Stack

- **HTML/CSS/Vanilla JS** — no frameworks, no npm, no build step
- **`localStorage`** — cart persistence (key: `kcmps_cart`)
- **CSP** — Content-Security-Policy enforced: `script-src 'self'`, same-origin images only
- **Auth** — existing Cognito login flow (untouched, 980 lines)
- **Deployment** — static files to S3

### Key Files

```
website/
├── index.html                          # Main page (restructured for conversion flow)
├── styles.css                          # Design tokens + all component styles
├── products.js                         # Catalog data (migration-ready shape)
├── store.js                            # Cart logic, drawer render, checkout
├── assets/
│   ├── logo-mark.png                  # Brand mark
│   ├── hero-*.png                     # Carousel images (hero-1 implicit, hero-2/3/4 new)
│   └── bg-texture.png                 # Page background texture (new)
└── Claude Design/KCMPS Redesign/
    └── styles.css                      # Synced copy for design-system reference docs
```

### Migration Path (Backend Integration)

Today the site is fully static. When ready to add a backend:

1. **Replace the `products.js` literal** with a fetch:
   ```javascript
   fetch('/api/catalog')
     .then(r => r.json())
     .then(d => { window.KCMPS_STORE_DATA = d; renderCatalog(); })
   ```

2. **Replace `submitOrder()` mailto with a real endpoint:**
   ```javascript
   const CHECKOUT_ENDPOINT = 'https://your-api.com/orders';
   // Inside submitOrder(), use fetch() instead of mailto
   ```

3. **Add a backend dashboard** for approving custom requests and processing SKU payments.

**No other code changes needed.** The data shape, cart logic, and UI are already designed for this swap.

## Design System

### Color Tokens

- **`--color-accent`**: `#f2882e` (orange) — reserved for primary CTAs only (Hormozi single-obvious-action)
- **`--color-accent-2`**: `#1d3f72` (navy) — brand secondary, buttons, headings
- **`--color-bg`**: `rgba(246, 247, 249, 0.92)` — page/card backgrounds (translucent)
- **`--color-surface`**: `rgba(236, 238, 242, 0.9)` — inherited backgrounds (slightly darker)
- **`--color-text`**: `#1a2b42` — body copy
- **`--color-divider`**: 12% navy with transparency — borders, separators

### Spacing & Radius

- **Spacing scale:** `--space-1` (4px) through `--space-8` (64px)
- **Radius:** `--radius-md` (6px), `--radius-lg` (12px)
- **Shadows:** `--shadow-sm`, `--shadow-md`, `--shadow-lg` (progressive depth)

### Typography

- **Heading font:** Plus Jakarta Sans (600, 700, 800 weights)
- **Body font:** Inter (400, 500, 600 weights)

## How to Run Locally

```bash
# Clone and navigate
cd /home/kennethdungca/Documents/Business/kcmps

# Open in browser (static file, no server needed)
open website/index.html
# or use a local HTTP server to avoid CORS issues:
python3 -m http.server 8000  # then visit http://localhost:8000/website/
```

## Testing Checklist

- [ ] Open in real browser (Chrome, Firefox, Safari)
- [ ] Verify hero carousel: slow 4s drift, 5.5s interval, arrows work, dots work, swipe on mobile
- [ ] Click through all 9 catalog leaves; confirm each shows product cards + custom-request card
- [ ] Add a priced SKU to cart; toggle "press onto shirt"; confirm price updates live (target ₱170)
- [ ] Add a custom request; open drawer; confirm "₱0 now / Pending approval"
- [ ] Checkout: fill form, submit; confirm order summary in `mailto:` (or configured endpoint)
- [ ] Resize to mobile (375px); confirm sticky-cta bar, drawer scrolls, no horizontal overflow
- [ ] Check console for JS errors
- [ ] Verify CSP is not violated (inspect Network tab for blocked requests)

## Editing Tips

### Change Carousel Timing
Edit `styles.css` line ~442:
```css
.carousel-track {
  transition: transform 4s cubic-bezier(0.45, 0, 0.55, 1); /* 4s slide duration */
}
```
And `index.html` line ~632:
```javascript
const AUTO_MS = 5500; // total interval = slide duration + pause
```

### Change Value Stack Amounts
Edit `index.html` around line 310 (clearly marked as owner-editable):
```html
<li class="vstack-line">
  <span>Free design file check & prep</span>
  <span class="strike">₱150</span>  <!-- Edit these values -->
</li>
```

### Change Guarantee Wording
Edit `index.html` around line 320 (clearly marked as owner-editable):
```html
<p>Love it, or we reprint it — free</p>  <!-- Edit this message -->
```

### Add a New Product
Edit `website/products.js`:
```javascript
{
  id: "dtf-new-design",
  leaf: "dtf",
  type: "sku",
  name: "Your Product Name",
  blurb: "Short description...",
  variants: [
    { label: "2×3 in", price: 50 },
    { label: "A4", price: 80 },
  ],
  shirtAddon: true,  // optional
}
```

### Change Checkout Endpoint
Edit `website/store.js` line ~20:
```javascript
const CHECKOUT_ENDPOINT = 'mailto:your-email@kcmps.com'; // or API URL
```

## Security & Compliance

- **CSP enforced:** same-origin scripts/styles only, no external fetches
- **Auth-popup guard:** storefront JS exits early when page is in OAuth mode
- **Sensitive data:** cart stays in `localStorage` (client-side only); checkout does not send payment details (billed separately after approval)
- **No external dependencies:** vanilla JS, no third-party libraries, minimal browser APIs

## Deployment

All files in `website/` are deployable as-is to S3 (or any static host):

```bash
aws s3 sync website/ s3://your-bucket/ --exclude "Claude Design/*"
```

The `Claude Design/` folder is for design-system reference docs — can be excluded from public deployment if desired.

## Support

- For design token changes or component tweaks, edit `website/styles.css` directly.
- For logic changes (cart, checkout), edit `website/store.js`.
- For catalog/product changes, edit `website/products.js`.
- For page structure or copy, edit `website/index.html`.

All changes are immediate (no build step required). Sync `styles.css` to `website/Claude Design/KCMPS Redesign/styles.css` after CSS edits so design-system docs stay current.

---

**Last updated:** July 2026  
**Design principles:** Alex Hormozi's Grand Slam offer (dream outcome, value stack, guarantee, risk reversal, single obvious CTA)  
**Migration status:** Frontend-only, backend hooks documented and ready to integrate
