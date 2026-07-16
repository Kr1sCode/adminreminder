# Pliki w formacie community-scripts (ProxmoxVE)

Ten katalog zawiera gotowe pliki zgodne ze strukturą repozytorium
[community-scripts/ProxmoxVE](https://github.com/community-scripts/ProxmoxVE),
przygotowane pod ewentualny przyszły Pull Request:

- `ct/adminredminer.sh` — skrypt hosta (sourcuje `build.func` z ProxmoxVE),
- `install/adminredminer-install.sh` — kroki instalacji wewnątrz kontenera,
- `json/adminredminer.json` — metadane aplikacji.

> **Uwaga:** te pliki **wymagają frameworka community-scripts** (`build.func` /
> `install.func`) i działają tylko po scaleniu z tamtym repozytorium.
>
> Aby zainstalować Admin Redminer **od razu**, bez zależności od community-scripts,
> użyj samodzielnego instalatora z katalogu [`../proxmox/install.sh`](../proxmox/install.sh):
>
> ```bash
> bash -c "$(curl -fsSL https://raw.githubusercontent.com/Kr1sCode/adminredminer/main/proxmox/install.sh)"
> ```
