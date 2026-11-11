# Deployment on the FAU Compute Cloud

The matcher runs on one VM in our project of the [FAU Compute Cloud](https://cc.rrze.de) (CC), an OpenStack cloud of the RRZE. The VM runs the same commands as a developer machine ([build and run](build.md)): the database in Docker and the MCP server as a service.

## The VM

| | |
|---|---|
| CC project | `amos2026ws04` |
| Name | `matcher` |
| Address | `172.17.72.173`, reachable only inside the FAU network or with [eduVPN](https://www.anleitungen.rrze.fau.de/internet-zugang/vpn/) |
| Image | Debian 13 |
| Size | Flavour `SCS-16V-32` (16 vCPUs, 32 GB RAM), 990 GB volume |
| Login user | `debian` |
| Repository on the VM | `/opt/patient-journey-matcher` |
| MCP server | Service `matcher-mcp`, `http://127.0.0.1:3000/mcp` on the VM |
| Database | Docker container `amos-postgres`, `127.0.0.1:5432` on the VM |

The size is the largest that fits our quota of 20 vCPUs, 50 GB RAM and 1000 GB volume storage. Together with the `vaultwarden` VM this uses almost all of it. If someone needs another VM, resize or rebuild this one first.

## Get access

1. Connect to eduVPN.
2. Log in at [cc.rrze.de](https://cc.rrze.de) with FAU SSO. Switch to the project `amos2026ws04` in the top left corner. If it is missing, ask the Scrum Master to add your CC account.
3. A key pair in the dashboard only works for VMs you launch yourself. For the existing VM, send your public SSH key to a developer who already has access. They add it:

   ```sh
   ssh debian@172.17.72.173 'cat >> ~/.ssh/authorized_keys' < your_key.pub
   ```

4. Log in: `ssh debian@172.17.72.173`

## Use the server

The MCP server has no authentication yet, so it listens on `127.0.0.1` of the VM only. Open a tunnel to use it from your machine:

```sh
ssh -L 3000:127.0.0.1:3000 debian@172.17.72.173
```

Then `http://127.0.0.1:3000/mcp` on your machine is the server on the VM, and the MCP Inspector commands from [build and run](build.md#run-the-matcher-locally) work unchanged.

On the VM:

| Task | Command |
|---|---|
| State of the server | `systemctl status matcher-mcp` |
| Log of the server | `journalctl -u matcher-mcp -f` |
| Restart the server | `sudo systemctl restart matcher-mcp` |
| Update to the newest `main` | `cd /opt/patient-journey-matcher && git pull && sudo systemctl restart matcher-mcp` |
| Fill the database and the index | `cd /opt/patient-journey-matcher && make seed && make index` |
| Log of the setup | `/var/log/matcher-setup.log` |

## Set up a new VM

[`deploy/vm-setup.sh`](../deploy/vm-setup.sh) does the whole setup: it installs Docker, Node.js 24, pnpm 12 and uv, clones this repository, writes a `.env` with a random database password, starts the database, runs the tests and starts the MCP server as a service.

1. In the dashboard, open **Compute → Instances → Launch Instance**.
2. **Details:** a name. **Source:** image `Debian 13`, create a new volume. **Flavour:** one without a root disk, such as `SCS-4V-8`. **Networks:** `FAU-Intern`. **Key Pair:** your key.
3. **Configuration:** paste the content of `deploy/vm-setup.sh` into **Customisation Script**.
4. Launch. The setup takes about 4 minutes. Follow it in the **Log** tab of the instance; it ends with the line `matcher-setup: done`.

On a VM that already exists, run the script with `sudo bash deploy/vm-setup.sh`. It is safe to run again.

## Limitations

- **No access from outside the FAU network.** The VM has no public address. AIlixir's app cannot call the server yet; this needs authentication first ([MCP interface](mcp-interface.md#open-questions), question 4).
- **The database is empty after the setup.** Run `make seed` and `make index` once; the first index run takes about 30 minutes ([limitations](build.md#limitations)).
- **Secrets stay on the VM.** The database password is in `/opt/patient-journey-matcher/.env`, readable only by `debian`. No API keys are needed.
