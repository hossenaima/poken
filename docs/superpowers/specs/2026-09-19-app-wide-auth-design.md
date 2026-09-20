# App-wide authentication — design

**Status:** design, not implemented
**Date:** 2026-09-19

## Problem

Signing in is only possible from the Learn screen. `renderAccount()` in `public/learn.js`
draws the Google button into `#learnAccount`, which lives inside `#learn-screen`, and the
"Sign in with Google to keep it" banner sits in the same screen. A user who lands on Poken
to teach never sees a way to sign in.

Two things are tangled underneath that symptom:

1. **Auth lives in the Learn Mode data layer.** `public/learn-store.js` creates the Supabase
   client and owns `signInWithGoogle`, `signOut`, `onAuthChange` and `currentUser` alongside
   the tree-storage methods. Anything outside Learn Mode that wants an account has to reach
   through Learn Mode's storage module to get one.
2. **Only Learn Mode can survive the redirect.** Google sign-in navigates away and returns to
   a cold page, so in-memory state is gone. `stashTree()` writes the tree to `sessionStorage`
   before leaving, and on the first auth event `learn.js` uses *the presence of that stash* to
   decide to re-open the Learn screen. A sign-in button anywhere else would return the user to
   the landing screen having lost their place.

So moving the button is not the change. The change is making auth an app-level concern with a
shared "where was I" mechanism.

## Non-goals

- **Nothing becomes gated.** Teaching and learning stay fully usable signed out, exactly as
  today. Sign-in remains an offer, never a wall.
- **No new per-user data.** Saving session history or past reflections to an account is the
  obvious follow-on and the reason a teaching-first user would sign in at all, but it is a
  separate feature with its own schema work. This design only makes the existing account
  reachable from anywhere.
- **No visual redesign.** The account control matches the current styling.

## Design

### 1. Lift auth out of the data layer

New `public/auth.js`, loaded before `app.js`, owns the Supabase client and the identity API,
and exposes `window.pokenAuth`:

| Member | Behaviour |
|---|---|
| `client()` | The shared Supabase client, created once, or `null` when unconfigured. |
| `currentUser()` | The signed-in user, or `null`. |
| `onAuthChange(cb)` | Subscribe; fires on boot and on every change. |
| `signIn(returnTo)` | Records the return intent (below), then starts the Google redirect. |
| `signOut()` | Signs out in place; no redirect. |

`learn-store.js` keeps every storage method and its public shape. It stops creating its own
client and stops owning auth: `window.pokenStore` re-exports `signInWithGoogle`, `signOut`,
`onAuthChange` and `currentUser` from `window.pokenAuth` so `learn.js` needs no change to its
storage calls. Two clients against one project would mean two token refresh loops racing over
the same storage key, so creation must move, not be duplicated.

Same failure contract as today: every auth call returns its failure value and never throws, so
a missing or misconfigured Supabase leaves the app fully usable.

### 2. One return-intent record

`sessionStorage["poken_return"]` = `{ screen, ts }`, written by `signIn()` immediately before
the redirect and cleared the first time it is read.

On boot, one router in `app.js` reads it and routes to that screen, then lets that screen
restore its own contents. Learn Mode keeps `stashTree`/`takeStash` for the tree itself — the
tree is Learn Mode's business — but stops using the stash as its routing signal. A record older
than ten minutes is ignored, so a stale tab does not hijack a later visit.

Screens register a restore hook:

```js
window.pokenScreens.register("learn", () => { /* re-open and rebuild */ });
```

### 3. Where the control appears

One `renderAccount()` that mounts into every `[data-poken-account]` element, so adding a screen
later is one attribute:

- **Landing** — the entry point, and the fix for the reported problem.
- **Setup** — where a returning user pauses before teaching.
- **Learn** — replaces the existing `#learnAccount` markup; unchanged to the eye.
- **Reflection** — next to the actions.
- **Not the live session.** That header already carries logo, persona, timer and status, and an
  accidental sign-out mid-lesson would drop the tree-save path while a session is running.

Signed out it is a "Sign in with Google" button; signed in it is the avatar, name and Sign out,
matching today's markup and CSS.

### 4. Just-in-time prompts stay

The Learn banner ("Sign in with Google to keep it") is the strongest pattern in the app because
it asks at the moment the user has something to lose. It stays, and calls the shared `signIn`.

## Risks

- **Rewiring a teammate's file.** `learn-store.js` is Jerry's. Keeping `window.pokenStore`'s
  shape identical is what makes this safe; `learn.js` should need no edit beyond deleting its
  local account rendering.
- **The redirect allow-list.** `redirectTo` is built from `location.origin`. Production moved to
  `poken.live` today, so Supabase → Authentication → URL Configuration must list
  `https://poken.live/**` and set Site URL, or sign-in fails silently on the new domain. This is
  a prerequisite, not a code change, and it is already recorded in NOTES.md.
- **Boot order.** `auth.js` must load before `app.js` and `learn-store.js`.

## Testing

Typecheck and `node --check` catch nothing about auth, so the checks are behavioural:

1. From each mount point: sign in, and confirm the return lands on that same screen.
2. Sign in from Learn with an unsaved tree: the tree is still there and gets saved.
3. Cancel at Google's consent screen: return to the same screen, still signed out, nothing lost.
4. Sign out from each mount point: stays on the screen, no redirect.
5. With Supabase unconfigured: no account control anywhere, and both modes work.
