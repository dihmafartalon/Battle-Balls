# Battle Balls — room server

One-time setup. After this you never touch it again.

## 1. Install Node (skip if you have it)
Check first: open a terminal and run `node -v`.
If you get a version number 20 or higher, you're done.
Otherwise install the LTS build from https://nodejs.org

## 2. Sign up at Cloudflare
https://dash.cloudflare.com/sign-up — free plan, no card needed.

## 3. Deploy
Unzip this folder, open a terminal inside it, and run:

    npx wrangler login      # opens a browser, click Allow
    npx wrangler deploy

Say yes to any install prompt. It takes about a minute.

## 4. Copy your URL
The last line printed looks like:

    https://battle-balls-rooms.YOUR-NAME.workers.dev

That's what I need. Paste it back to me.

## 5. Check it works
Open this in a browser, replacing the host with yours:

    https://battle-balls-rooms.YOUR-NAME.workers.dev/health

It should print `ok`. If it does, the server is live.

## Costs
Nothing at your scale. Cloudflare's free plan covers Durable Objects,
and a few friends playing is a rounding error against the free limits.

## What this does
Holds one room per lobby code, elects the longest-connected player as
host, and relays messages between everyone in the room. The host's
browser is authoritative for the ball and the bots; this server is a
smart relay that enforces who is allowed to send what.

## Cloud saves (Sign in with Google)
The same Worker also keeps each player's save, under Google's number for
their account (never their email or name). To switch it on:

1. Put your Google **Client ID** into `wrangler.toml`:

       GOOGLE_CLIENT_ID = "1234-abc.apps.googleusercontent.com"

2. Deploy again from this folder:

       npx wrangler deploy

   The first deploy after this change creates the new "Vault" storage. Rooms
   keep working exactly as before.

3. Check it: open `https://battle-balls-rooms.YOUR-NAME.workers.dev/health`
   and it should still print `ok`.

Free plan limits (per day): 100,000 Durable Object requests and 100,000
storage writes. The game saves to the cloud at most every 30 seconds while
something has changed, so this covers hundreds of hours of play a day.

## The economy, the anticheat and the admin page
Coins, yen, RP, items, the pass and free spins now live on this server. The
game asks the server to open a chest, sell, spin, finish a match and so on;
it can no longer write them itself. Cheating is caught here and can ban an
account, and `/admin` lets you look up any player and change what they have.

**Upload order matters: the site first, then this server.** The new site
keeps working the old way until it hears from a new server, so it is safe
to put up early. The other way round, players with an old copy of the site
open would lose coins they earn until they reload.

1. Set the admin password (a long one, 12+ characters). It is a secret, so it
   never goes in a file:

       npx wrangler secret put ADMIN_KEY

   Type the password when it asks. Without it, `/admin` stays locked.

2. Deploy:

       npx wrangler deploy

   The first deploy creates the new "Directory" storage (the player list for
   the admin page). Everything else carries on as before.

3. Open `https://battle-balls-rooms.YOUR-NAME.workers.dev/admin` and sign in
   with that password.

**Every time items, prices, the pass or ranks change in the game,** the
server needs the new list too: build the site, then upload this server again.
(The build writes `src/catalog.js` from the game file automatically.)

## Redeem codes are yours alone
Codes only pay out to the accounts listed in `wrangler.toml`:

    OWNER_ACCOUNTS = "1234567890"

To find your number: sign in to the game with Google once, then open `/admin`,
find yourself by your in-game name, and copy the number after "Account".
Put it in, deploy again (`npx wrangler deploy`), and your codes work — for
you only. For everyone else, and for anyone signed out, a real code looks
exactly like a wrong one.

## The leaderboard
`/leaderboard` lists the ten accounts with the most RP (banned accounts are
left off), shown on the board in the lobby and on the Ranked screen. It only
ever gives out in-game names and RP. It fills in as players sign in and play:
an account shows up once it has RP and has been online since this update.
