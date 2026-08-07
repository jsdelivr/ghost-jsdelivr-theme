# ghost-jsdelivr-theme
The Ghost theme for jsDelivr's blog


### Compile SASS:

```
$ sass --watch assets/styles/scss:assets/styles
```

### Local Ghost preview

Prerequisites:

- Node.js 22
- Docker Desktop with Docker Compose

Create a snapshot of the public jsDelivr blog content, start Ghost, create the local owner, import the snapshot, and activate this theme:

```sh
npm run ghost:setup
```

The command prints the generated local admin credentials and stores them in the ignored `.ghost-local/admin.json` file. Open http://localhost:2378 to preview the theme or http://localhost:2378/ghost to use Ghost Admin. Re-running the command keeps the existing local owner and skips the import when the public fixture is already present.

The repository is mounted directly as the theme, so edits to existing theme files are available without rebuilding the container. If a newly added theme file is not detected, restart Ghost.

Useful commands:

```sh
npm run ghost:logs
npm run ghost:stop
npm run ghost:start
```

To refresh the imported preview data, reset the local database and run the setup again:

```sh
docker compose down -v
npm run ghost:setup
```

> [!WARNING]
> `docker compose down -v` removes the `ghost-content` volume and all local Ghost data. The setup command recreates the owner with the credentials already saved in `.ghost-local/admin.json` and imports the latest generated fixture.
