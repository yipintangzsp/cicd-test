# ZhangLab V14 Access Recovery

This note is for the case where Jenkins, GitLab, Grafana, Kibana, or the public Cloudflare portal cannot be opened.

## Current access layers

- Local preview: `http://127.0.0.1:30114/`
- LAN Jenkins: `http://jenkins.devops.local/` or `http://192.168.1.58:30659/`
- LAN GitLab: `http://192.168.1.58:30080/`
- LAN V14 portal: `http://192.168.1.58:30089/`
- Public V14 portal: `https://platform.heil.ccwu.cc/`

## Read-only diagnosis order

Run these checks from the Mac before changing anything:

```bash
dscacheutil -q host -a name jenkins.devops.local
ifconfig en0
arp -a | grep 192.168.1.58
ping -c 3 192.168.1.58
nc -vz 192.168.1.58 22
nc -vz 192.168.1.58 30659
nc -vz 192.168.1.58 30080
curl -I -m 10 https://platform.heil.ccwu.cc/
```

## How to read the result

- DNS resolves to `192.168.1.58`, but ARP is `incomplete`: the Mac cannot see the server on the local network. Check server power, cable, Wi-Fi, switch port, or whether the server IP changed.
- Ping and every TCP port time out: do not restart Jenkins or change Kubernetes. First restore host reachability.
- Cloudflare returns `530`: the tunnel or origin is down. If LAN access is also down, fix the `192.168.1.58` host first.
- LAN works but Cloudflare fails: check `cloudflared` service and the Cloudflare tunnel route.
- Jenkins works but GitLab does not: check the GitLab pod/service/NodePort after SSH or kubectl access is restored.

## Local preview while the server is down

The generated V14 frontend can be previewed locally without the server:

```bash
cd /Users/zhangsir/code/gitLab/reports/v14-portal
python3 -m http.server 30114 --bind 127.0.0.1
```

Open:

```text
http://127.0.0.1:30114/
```

This only previews the generated portal. It does not prove Jenkins, Grafana, Kibana, GitLab, Kubernetes, or Cloudflare are healthy.

## Safety rule

Do not delete PVCs, backups, images, namespaces, or workloads while recovering access. If the host is unreachable, do not attempt Kubernetes changes from memory. Restore network access first, then run read-only cluster inventory before making any reversible change.
