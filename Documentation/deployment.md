# Deployment on the FAU Compute Cloud

The matcher runs on one VM in our project of the [FAU Compute Cloud](https://cc.rrze.de) (CC), an OpenStack cloud of the RRZE. The VM runs the same commands as a developer machine ([build and run](build.md)): the database and the crawlers in Docker, the MCP server as a service, and timers for the crawls and the index.

## The VM

| | |
|---|---|
| CC project | `amos2026ws04` |
| Name | `matcher` |
| Address | `172.17.72.205`, reachable only inside the FAU network or with [eduVPN](https://www.anleitungen.rrze.fau.de/internet-zugang/vpn/) |
| Image | Debian 13 |
| Size | Flavour `SCS-16V-32` (16 vCPUs, 32 GB RAM), 700 GB volume |
| Login user | `debian` |
| Repository on the VM | `/opt/patient-journey-matcher` |
| MCP server | Service `matcher-mcp`, `http://127.0.0.1:3000/mcp` on the VM |
| Database | Docker container `amos-postgres`, `127.0.0.1:5432` on the VM |
| Crawlers and index | Timers `crawler-<source>` and `matcher-index`, see [scheduled crawls](#scheduled-crawls) |
| Backups | `/var/backups/matcher`, see [backups and cleanup](#backups-and-cleanup) |

Our quota is 20 vCPUs, 50 GB RAM and 1000 GB volume storage. The flavour is the largest that fits the RAM quota. Together with the `vaultwarden` VM, 3 vCPUs, 17 GB RAM and 290 GB volume storage are left for other VMs.

## Get access

To log in to the VM you need eduVPN and your SSH key on the VM. You do not need the cloud dashboard for that.

1. Install [eduVPN](https://www.anleitungen.rrze.fau.de/internet-zugang/vpn/) and connect with your FAU login.
2. If you have no SSH key yet, create one. Press Enter for the default file name:

   ```sh
   ssh-keygen -t ed25519
   ```

3. Print your public key and send it to a developer who already has access, for example in Slack. The public key is not a secret. Never send the file without `.pub`.

   ```sh
   cat ~/.ssh/id_ed25519.pub
   ```

4. That developer adds the line on the VM:

   ```sh
   echo 'ssh-ed25519 AAAA... name' >> ~/.ssh/authorized_keys
   ```

5. Log in: `ssh debian@172.17.72.205`

**Accounts.** Everyone logs in as the same user `debian`, which may use `sudo`. There are no personal accounts on the VM. To take access away from someone, delete their line from `/home/debian/.ssh/authorized_keys`.

**Cloud dashboard.** You only need [cc.rrze.de](https://cc.rrze.de) to launch, resize or delete VMs and to read the boot log. Log in with FAU SSO and switch to the project `amos2026ws04` in the top left corner. If the project is missing, ask the Scrum Master to add your CC account. A key pair in the dashboard only works for VMs you launch yourself, not for the existing VM.

## Use the server

The MCP server has no authentication yet, so it listens on `127.0.0.1` of the VM only. Open a tunnel to use it from your machine:

```sh
ssh -L 3000:127.0.0.1:3000 debian@172.17.72.205
```

Then `http://127.0.0.1:3000/mcp` on your machine is the server on the VM, and the MCP Inspector commands from [build and run](build.md#run-the-matcher-locally) work unchanged.

On the VM:

| Task | Command |
|---|---|
| State of the server | `systemctl status matcher-mcp` |
| Log of the server | `journalctl -u matcher-mcp -f` |
| Restart the server | `sudo systemctl restart matcher-mcp` |
| Update to the newest `main` | `cd /opt/patient-journey-matcher && git pull && sudo systemctl restart matcher-mcp` |
| Log of the setup | `/var/log/matcher-setup.log` |

## Scheduled crawls

Every night a systemd timer starts one crawler container per source (`crawler-<source>` in [`compose.yaml`](../compose.yaml)), and in the morning `make index` adds the new documents to the indexes. Each run continues from the source's last successful run (`--since auto`, see [crawler](../crawler/README.md#run)). A topic without one, as on a new VM or with a new topic file, is crawled without a date. `--max-results` caps every query, channel or feed in every run, so it also sets the size of this first crawl.

| Source | Starts (UTC) | Results per run | Bound by |
|---|---|---|---|
| PubMed | 03:00 | 50 per query | NCBI: 3 requests/s, 5 with our key, large jobs between 21:00 and 05:00 US Eastern. Under an hour, the first crawl a few hours. |
| arXiv | 00:00 | 3 per query | 1 request every 3 s: at least 3 hours for the 3,615 queries, the first crawl about 12 hours. |
| Zenodo | 00:10 | 25 per query (one page) | 30 searches a minute: about 2 hours. |
| YouTube | 00:30 | 50 per channel | 10,000 quota units a day, a run needs about 1,400. Stored videos expire after 30 days unless a run refreshes them, so it must run at least every 14 days. |
| Podcasts | 00:20 | 100 per feed | One request per feed and day, 277 feeds: about 15 minutes. |
| Index | 06:00 | New and changed documents | arXiv allows one download every 15 s: the first index after the first crawl takes 1–2 days. |

The scheduled runs do not follow references (`--max-depth 0`): on a first crawl they would fetch millions of cited papers.

**API keys** go into `/opt/patient-journey-matcher/crawler/.env`, which the setup creates from [`crawler/.env.example`](../crawler/.env.example). YouTube needs `YOUTUBE_API_KEY`; PubMed should have `NCBI_ENTREZ_EMAIL` and `NCBI_API_KEY`. Without a YouTube key, turn its timer off: `sudo systemctl disable --now crawler-youtube.timer`.

| Task | Command |
|---|---|
| Next and last runs | `systemctl list-timers 'crawler-*' matcher-index.timer` |
| Log of a run | `journalctl -u crawler@pubmed`, `journalctl -u matcher-index` |
| Crawl a source now | `sudo systemctl start --no-block crawler@pubmed` |
| Stored runs | `docker exec amos-postgres psql -U amos -d patient_journey_matcher -c 'SELECT source, started_at, ok, inserted FROM crawl_runs ORDER BY id DESC LIMIT 10'` |
| Failed runs | `systemctl --failed` |

## Backups and cleanup

**Backups.** Every night at 23:00 UTC, [`deploy/backup-db.sh`](../deploy/backup-db.sh) dumps the database to `/var/backups/matcher/matcher-<date>.dump` and keeps the newest 7. The dumps are on the same volume as the database: they help against a broken database or `docker compose down -v`, not against losing the VM. To restore one, stop the timers that write to the database, then:

```sh
docker exec -i amos-postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  < /var/backups/matcher/matcher-2026-11-20.dump
```

**Cleanup.** Every Sunday at 23:30 UTC, `matcher-prune` removes Docker images that newer builds replaced and build cache older than a week.

| Task | Command |
|---|---|
| Back up now | `sudo systemctl start matcher-backup` |

## Set up a new VM

[`deploy/vm-setup.sh`](../deploy/vm-setup.sh) does the whole setup: it installs Docker, Node.js 24, pnpm 12 and uv, clones this repository, writes a `.env` with a random database password, starts the database, runs the tests, starts the MCP server as a service and installs the timers for the crawls, the index, the backups and the cleanup.

1. In the dashboard, open **Compute → Instances → Launch Instance**.
2. **Details:** a name. **Source:** image `Debian 13`, create a new volume. **Flavour:** one without a root disk, such as `SCS-4V-8`. **Networks:** `FAU-Intern`. **Key Pair:** your key.
3. **Configuration:** paste the content of `deploy/vm-setup.sh` into **Customisation Script**.
4. Launch. The setup takes about 4 minutes. Follow it in the **Log** tab of the instance; it ends with the line `matcher-setup: done`.

On a VM that already exists, run the script with `sudo bash deploy/vm-setup.sh`. It is safe to run again.

## Limitations

- **No access from outside the FAU network.** The VM has no public address. AIlixir's app cannot call the server yet; this needs authentication first ([MCP interface](mcp-interface.md#open-questions), question 4).
- **The database is empty until the first night.** Then every source crawls all topics for the first time ([scheduled crawls](#scheduled-crawls)).
- **Secrets stay on the VM.** The database password is in `/opt/patient-journey-matcher/.env` and the API keys are in `crawler/.env`, both readable only by `debian`.
