# Hazel

This project lets you deploy an update server for [Electron](https://www.electronjs.org) apps with ease.

This fork runs on [Cloudflare Workers](https://workers.cloudflare.com) instead of Vercel.

- Recommended by Electron [here](https://www.electronjs.org/docs/tutorial/updates#deploying-an-update-server)
- Pulls the latest release data from [GitHub Releases](https://help.github.com/articles/creating-releases/) and caches it in memory and in the [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) of each Cloudflare data center
- Refreshes the cache every **15 minutes** (custom interval [possible](#options))
- When asked for an update, it returns the link to the GitHub asset directly (saves bandwidth)
- Supports **macOS** and **Windows** apps
- If GitHub cannot be reached, keeps serving the release it cached last

## Usage

1. Install the dependencies: `yarn`
2. Set `ACCOUNT` and `REPOSITORY` in [`wrangler.toml`](wrangler.toml) to the GitHub user/org and repository that holds the releases of your Electron app.
3. Log in to Cloudflare and deploy:

   ```sh
   npx wrangler login
   yarn deploy
   ```

4. Optional, but recommended for public repositories: GitHub only allows 60 unauthenticated API requests per hour per IP address, and Workers share their IP addresses. Add a token (a fine-grained token with read-only access to the repository's contents is enough) to get a higher limit:

   ```sh
   npx wrangler secret put GITHUB_TOKEN
   ```

5. To serve the Worker on your own domain (the domain must be on Cloudflare), uncomment `routes` in [`wrangler.toml`](wrangler.toml) and deploy again.

Once it's deployed, paste the deployment address into your code (please keep in mind that updates should only occur in the production version of the app, not while developing):

```js
const { app, autoUpdater } = require('electron')

const server = <your-deployment-url>
const url = `${server}/update/${process.platform}/${app.getVersion()}`

autoUpdater.setFeedURL({ url })
```

That's it! :white_check_mark:

From now on, the auto updater will ask your Hazel deployment for updates!

## Options

Variables are set in the `[vars]` section of [`wrangler.toml`](wrangler.toml), secrets with `npx wrangler secret put <NAME>`:

- `ACCOUNT` and `REPOSITORY` (required): Where the releases of your app are published
- `INTERVAL`: Refreshes the cache every x minutes ([restrictions](https://developer.github.com/changes/2012-10-14-rate-limit-changes/)) (defaults to 15 minutes)
- `PRE`: When defined with a value of `1`, only pre-releases will be cached
- `TOKEN` (secret): Your GitHub token (for private repos). Downloads are then sent through this server, which asks GitHub for a download link
- `GITHUB_TOKEN` (secret): A GitHub token that is only used to raise the API rate limit, for public repos
- `URL`: The server's public URL, used for download links in private repo mode (defaults to the address the request was sent to)

## Statistics

Since Hazel routes all the traffic for downloading the actual application files to [GitHub Releases](https://help.github.com/articles/creating-releases/), you can use their API to determine the download count for a certain release.

As an example, check out the [latest Hyper release](https://api.github.com/repos/vercel/hyper/releases/latest) and search for `mac.zip`. You'll find a release containing a sub property named `download_count` with the amount of downloads as its value.

## Routes

### /

Displays an overview page showing the cached repository with the different available platforms and file sizes. Links to the repo, releases, specific cached version and direct downloads for each platform are present.

### /download

Automatically detects the platform/OS of the visitor by parsing the user agent and then downloads the appropriate copy of your application.

If the latest version of the application wasn't yet pulled from [GitHub Releases](https://help.github.com/articles/creating-releases/), it will return a message and the status code `404`. The same happens if the latest release doesn't contain a file for the detected platform.

### /download/:platform

Accepts a platform (like "darwin" or "win32") to download the appropriate copy your app for. I generally suggest using either `process.platform` ([more](https://nodejs.org/api/process.html#process_process_platform)) or `os.platform()` ([more](https://nodejs.org/api/os.html#os_os_platform)) to retrieve this string.

If the cache isn't filled yet or doesn't contain a download link for the specified platform, it will respond like `/`.

### /update/:platform/:version

Checks if there is an update available by reading from the cache.

If the latest version of the application wasn't yet pulled from [GitHub Releases](https://help.github.com/articles/creating-releases/), it will return the `204` status code. The same happens if the latest release doesn't contain a file for the specified platform.

### /update/win32/:version/RELEASES

This endpoint was specifically crafted for the Windows platform (called "win32" [in Node.js](https://nodejs.org/api/process.html#process_process_platform)).

Since the [Windows version](https://github.com/Squirrel/Squirrel.Windows) of Squirrel (the software that powers auto updates inside [Electron](https://www.electronjs.org)) requires access to a file named "RELEASES" when checking for updates, this endpoint will respond with a cached version of the file that contains a download link to a `.nupkg` file (the application update).

## Programmatic Usage

You can add Hazel to an existing Worker, if you want. For example, this will allow you to implement custom analytics on certain paths.

```js
import { createHandler } from './lib/index.js'

const hazel = createHandler({ account: 'acme', repository: 'app' })

export default {
  fetch(request, env, ctx) {
    return hazel(request, ctx)
  }
}
```

## Contributing

1. [Fork](https://help.github.com/articles/fork-a-repo/) this repository to your own GitHub account and then [clone](https://help.github.com/articles/cloning-a-repository/) it to your local device
2. Move into the directory of your clone: `cd hazel`
3. Install the dependencies with `yarn` and run the development server: `yarn dev`
4. Run the tests: `yarn test`

## Credits

Huge thanks to my ([@leo](https://github.com/leo)'s) friend [Andy](http://twitter.com/andybitz_), who suggested the name "Hazel" (since the auto updater software inside [Electron](https://www.electronjs.org) is called "Squirrel") and [Matheus](https://twitter.com/matheusfrndes) for collecting ideas with me.

## Author

Leo Lamprecht ([@notquiteleo](https://twitter.com/notquiteleo)) - [Vercel](https://vercel.com)
