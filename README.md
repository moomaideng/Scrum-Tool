# Scrum Retrospective Tool

A small shared board for one Scrum retrospective. Team members join with a name, then add notes under **Continue**, **Cancel**, and **Add**.

The **Reset board** button deliberately removes every participant and note after confirmation. Use it to start the next retrospective with a clean board.

It is intentionally separate from Eventory. It runs as one Docker container and stores its data in a named Docker volume, so restarts and image updates do not remove the board.

## Run locally with Docker

1. Copy `.env.example` to `.env` if you want to change the local port.
2. Run:

   ```bash
   docker compose up --build
   ```

3. Open [http://localhost:4173](http://localhost:4173).

To stop it, use `docker compose down`. This keeps the board data. `docker compose down --volumes` removes the board data too.

## Local development

```bash
npm install
npm test
npm run dev
```

The development server uses `http://localhost:3000`. Persistent development data is written to `data/`, which is ignored by Git.

## Deployment notes

Pushes to `main` deploy automatically through [`.github/workflows/ci.yml`](.github/workflows/ci.yml). The workflow builds an ARM64 image, publishes it to GitHub Container Registry, then deploys it to `/opt/scrum-tool` on the Oracle server. It uses the same repository secrets as Eventory:

- `ORACLE_HOST`
- `ORACLE_USER`
- `ORACLE_SSH_KEY`
- `ORACLE_KNOWN_HOSTS`

The deployed service listens on port `4173`. Ensure Oracle's security list and host firewall allow that port before the first deployment, or change `RETROSPECTIVE_PORT` in the workflow and its verification URL together.

The name field is only a team identity, not authentication. Keep the port limited to your team/network if the notes should be private. Proper account authentication is needed before using it for sensitive or public content.
