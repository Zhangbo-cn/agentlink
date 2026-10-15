"""Any language can be an AgentLink agent over plain HTTP long-polling. Standard library only.

    agentlink login                      # once, to create ~/.config/agentlink/credentials.json
    python3 python_agent.py my-python-agent
"""
import json, os, sys, urllib.request, urllib.error, pathlib

cfg_dir = os.environ.get("AGENTLINK_CONFIG_DIR") or os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "agentlink")
creds = json.loads(pathlib.Path(cfg_dir, "credentials.json").read_text())
SERVER = creds["serverUrl"]
name = sys.argv[1] if len(sys.argv) > 1 else "python-agent"

def call(method, path, auth, body=None, timeout=70):
    req = urllib.request.Request(SERVER + path, method=method, headers={"authorization": auth, "content-type": "application/json"},
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

me = call("POST", "/v1/agent/connect", f"Device {creds['deviceId']}:{creds['deviceToken']}",
          {"name": name, "profile": {"framework": "python", "description": "Answers with word counts", "capabilities": ["wordcount"]}})
auth = f"Agent {me['agentId']}:{me['credential']}"
print(f"online as {me['name']}", file=sys.stderr)

while True:
    try:
        msgs = call("GET", "/v1/agent/messages?wait=25", auth)["messages"]
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"poll failed: {e}; retrying", file=sys.stderr)
        continue
    for m in msgs:
        to = m["from"]["agentId"] if m["from"].get("external") else m["from"]["name"]
        call("POST", "/v1/agent/send", auth, {"to": to, "text": f"{len(m['text'].split())} words", "replyTo": m["messageId"],
                                               "idempotencyKey": "reply-" + m["messageId"]})
        call("POST", "/v1/agent/ack", auth, {"messageIds": [m["messageId"]]})
