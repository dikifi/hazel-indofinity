// The overview page shown at `/`. This used to be a Handlebars template, but
// Handlebars compiles templates with `new Function`, which Cloudflare Workers
// does not allow, so the page is a plain template string now.

const entities = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '`': '&#x60;',
  '=': '&#x3D;'
}

const escape = value =>
  String(value === undefined || value === null ? '' : value).replace(
    /[&<>"'`=]/g,
    character => entities[character]
  )

const renderFile = file => `
              <div class="item">
                <div class="fileType">Terbaru: <span class="url"><a href="${escape(file.url)}">Download IndoFinity</a></span></div>
                <div class="size">${escape(file.size)} MB</div>
              </div>`

export default ({
  account,
  repository,
  date,
  files,
  version
}) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">

    <title>${escape(account)}/${escape(repository)}</title>

    <style>
      body {
        box-sizing: border-box;
        padding: 20px;
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont,
        "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell,
        "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
        background: black;
        color: white;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        text-rendering: optimizeLegibility;
        height: 100vh;
      }

      #wrap {
        display: flex;
        align-items: center;
        height: 100%;
      }

      main {
        width: 500px;
        margin: 0 auto;
      }

      header {
        display: flex;
        align-items: center;
        font-size: 24px;
        margin-bottom: 40px;
      }

      #release {
        flex-grow: 1;
      }

      #repo {
        font-weight: 800;
      }

      #date {
        color: gray;
        font-size: 18px;
      }

      .item {
        display: flex;
        align-items: center;
      }

      .item:not(:last-of-type) {
        margin-bottom: 14px;
      }

      .item a {
        color: #ff0387;
        text-decoration: none;
      }

      .item a:hover {
        text-decoration: underline;
      }

      .fileType {
       font-weight: 600;
       flex-grow: 1;
      }

      .url {
        font-weight: 400;
      }

      .size {
        color: #404040;
        white-space: nowrap;
      }

      footer {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
      }

      footer > * {
        margin-top: 40px;
      }

      footer a {
        color: gray;
        text-decoration: none;
      }

      footer a:hover {
        text-decoration: underline;
      }

      #version {
        margin-right: 8px;
        padding: 2px 6px;
        border-radius: 4px;
        background: linear-gradient(#ff00a5, #f65538)
      }

      #release-notes {
        font-weight: 600;
        color: white;
      }

      #all-releases {
        text-align: center;
        flex-grow: 1;
      }
    </style>
  </head>

  <body>
    <div id="wrap">
      <main>
          <header>
            <div id="release">${escape(account)}/<span id="repo">${escape(repository)}</span></div>
            <div id="date">${escape(date)}</div>
          </header>

          <div id="list">${Object.values(files || {})
            .map(renderFile)
            .join('')}
          </div>

          <footer>
            <div id="version">${escape(version)}</div>
          </footer>
      </main>
    </div>
  </body>
</html>
`
