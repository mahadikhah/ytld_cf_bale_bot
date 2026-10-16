#!/usr/bin/env python3
"""Delete expired bot-uploaded files from S3, identified by their .txt marker files."""
import os, time, subprocess

def cleanup_account(num):
    prefix = f"S3_ACCOUNT_{num}_"
    endpoint = os.environ.get(f"{prefix}ENDPOINT")
    if not endpoint:
        return
    access_key = os.environ.get(f"{prefix}ACCESS_KEY")
    secret_key = os.environ.get(f"{prefix}SECRET_KEY")
    region = os.environ.get(f"{prefix}REGION")
    bucket = os.environ.get(f"{prefix}BUCKET_NAME")
    if not all([access_key, secret_key, region, bucket]):
        return

    env = {
        **os.environ,
        "AWS_ACCESS_KEY_ID": access_key,
        "AWS_SECRET_ACCESS_KEY": secret_key,
        "AWS_DEFAULT_REGION": region,
    }
    base_cmd = ["--endpoint-url", endpoint, "--region", region]

    # List every object in the bucket
    cmd = ["aws", "s3", "ls", f"s3://{bucket}/", "--recursive"] + base_cmd
    res = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=120)
    if res.returncode != 0:
        print(f"[Account {num}] list failed: {res.stderr.strip()}")
        return

    # Collect only marker files (*.txt) – these are the safe‑to‑delete candidates
    markers = []
    for line in res.stdout.strip().splitlines():
        parts = line.split(maxsplit=3)
        if len(parts) < 4:
            continue
        key = parts[3]
        if key.endswith(".txt"):
            markers.append(key)

    print(f"[Account {num}] Found {len(markers)} marker file(s)")
    now = int(time.time())
    deleted = 0

    for marker in markers:
        try:
            # Fetch the marker content (contains expiry epoch)
            subprocess.run(
                ["aws", "s3", "cp", f"s3://{bucket}/{marker}", "/tmp/marker.txt"] + base_cmd,
                capture_output=True, text=True, env=env, timeout=30, check=True
            )
            with open("/tmp/marker.txt") as f:
                content = f.read().strip()
            expiry = int(content)
            if expiry >= now:
                continue  # still valid, skip

            # Delete the main file (strip .txt from the marker key)
            main_key = marker[:-4]
            subprocess.run(
                ["aws", "s3", "rm", f"s3://{bucket}/{main_key}"] + base_cmd,
                capture_output=True, text=True, env=env, timeout=30
            )
            # Delete the marker itself
            subprocess.run(
                ["aws", "s3", "rm", f"s3://{bucket}/{marker}"] + base_cmd,
                capture_output=True, text=True, env=env, timeout=30
            )
            print(f"[Account {num}] Deleted expired: {main_key}")
            deleted += 1
        except Exception as e:
            print(f"[Account {num}] Error on {marker}: {e}")

    print(f"[Account {num}] Cleanup done – deleted {deleted} expired file(s)")

# Run for each configured account
start = int(os.environ.get("STARTING_S3_ACCOUNT_NUMBER", "1"))
for i in range(start, 6):
    cleanup_account(i)
print("Cleanup finished.")
