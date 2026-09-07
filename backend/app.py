from flask import Flask, jsonify, request
from flask_cors import CORS
from pyngrok import ngrok
from web3 import Web3
import copy
import hashlib
import json
import joblib
import os
import time


app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(BASE_DIR)
MODEL_DIR = os.path.join(BASE_DIR, "models")
DATASET_DIR = os.path.join(BASE_DIR, "datasets")
UPLOAD_MODEL_DIR = MODEL_DIR
UPLOAD_DATASET_DIR = DATASET_DIR
MANUALLY_TRUSTED = set()
ACTIVE_MODEL_VERSION = None

SIM_CHAIN_FILE = os.path.join(BASE_DIR, "sim_chain.json")
POW_DIFFICULTY = 3
BLOCK_TX_CAPACITY = 3
SIM_BLOCKCHAIN = []
PENDING_TRANSACTIONS = []
MODEL_FILE_STATE = {}
DELETED_MODEL_HASHES = set()
INTEGRITY_EVENTS = []
MAX_EVENTS = 200

os.makedirs(UPLOAD_MODEL_DIR, exist_ok=True)
os.makedirs(UPLOAD_DATASET_DIR, exist_ok=True)


def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def classify_status(current_hash, blockchain_hash, dataset_changed=False, trusted=False):
    if blockchain_hash is None:
        return "MISSING", "Block not committed to blockchain"
    if current_hash is None:
        return "MISSING", "Model file missing locally"
    if trusted:
        return "VALID", "Manually trusted after review"
    if current_hash != blockchain_hash:
        return "TAMPERED", "Hash mismatch detected"
    if dataset_changed:
        return "AT_RISK", "Dataset changed after training"
    return "VALID", "Model integrity verified"


def status_to_css(status):
    mapping = {
        "VALID": "valid",
        "MISSING": "missing",
        "TAMPERED": "tampered",
        "AT_RISK": "risk",
    }
    return mapping.get(status, "missing")


def get_model_hash_from_file(model_hash):
    candidates = [
        os.path.join(MODEL_DIR, f"{model_hash}.pkl"),
        os.path.join(PROJECT_DIR, "models", f"{model_hash}.pkl"),
    ]
    model_path = None
    for candidate in candidates:
        if os.path.exists(candidate):
            model_path = candidate
            break

    if model_path is None:
        return None

    try:
        with open(model_path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except Exception as exc:
        print("FILE ERROR:", exc)
        return None


def model_file_exists(model_hash):
    candidates = [
        os.path.join(MODEL_DIR, f"{model_hash}.pkl"),
        os.path.join(PROJECT_DIR, "models", f"{model_hash}.pkl"),
    ]
    return any(os.path.exists(path) for path in candidates)


def get_file_status(model_hash, tx_source=None):
    if not model_hash:
        return "MISSING", "Model hash missing in transaction"

    current_hash = get_model_hash_from_file(model_hash)
    if current_hash is None:
        if model_hash in DELETED_MODEL_HASHES:
            return "MISSING", "Model file missing locally"
        if tx_source == "BACKFILL":
            return "VALID", "Historical record (local file not tracked)"
        return "VALID", "Local file not tracked on this node"
    if current_hash != model_hash:
        return "TAMPERED", "Hash mismatch detected"
    return "VALID", "Model file verified"


def append_integrity_event(event_type, model_hash, details):
    event = {
        "id": sha256_text(f"{event_type}:{model_hash}:{int(time.time() * 1000)}"),
        "type": event_type,
        "model_hash": model_hash,
        "details": details,
        "timestamp": int(time.time()),
    }
    INTEGRITY_EVENTS.append(event)
    if len(INTEGRITY_EVENTS) > MAX_EVENTS:
        del INTEGRITY_EVENTS[: len(INTEGRITY_EVENTS) - MAX_EVENTS]


def detect_model_file_deletions():
    tx_hashes = set()
    for block in SIM_BLOCKCHAIN:
        for tx in block.get("transactions", []):
            model_hash = tx.get("model_hash")
            if model_hash:
                tx_hashes.add(model_hash)

    for model_hash in tx_hashes:
        current_exists = model_file_exists(model_hash)
        previous_exists = MODEL_FILE_STATE.get(model_hash)
        if previous_exists is True and current_exists is False:
            DELETED_MODEL_HASHES.add(model_hash)
            append_integrity_event(
                event_type="MODEL_DELETED",
                model_hash=model_hash,
                details="Model file deleted from local models directory",
            )
        if current_exists is True and model_hash in DELETED_MODEL_HASHES:
            DELETED_MODEL_HASHES.remove(model_hash)
        MODEL_FILE_STATE[model_hash] = current_exists


def get_record_count():
    return contract.functions.getRecordCount().call()


def ensure_valid_index(index):
    count = get_record_count()
    if index < 0 or index >= count:
        return False, count
    return True, count


def build_record(index, previous_dataset_hash=None):
    row = contract.functions.records(index).call()
    dataset_hash = row[0]
    blockchain_hash = row[1]
    current_hash = get_model_hash_from_file(blockchain_hash)
    dataset_changed = previous_dataset_hash is not None and previous_dataset_hash != dataset_hash
    trusted = (index + 1) in MANUALLY_TRUSTED

    status, reason = classify_status(
        current_hash=current_hash,
        blockchain_hash=blockchain_hash,
        dataset_changed=dataset_changed,
        trusted=trusted,
    )

    return {
        "version": index + 1,
        "dataset_hash": dataset_hash,
        "model_hash": current_hash,
        "blockchain_hash": blockchain_hash,
        "accuracy": row[2],
        "timestamp": row[3],
        "user": row[4],
        "dataset_changed": dataset_changed,
        "status": status,
        "reason": reason,
        "status_class": status_to_css(status),
    }


def merkle_root(hashes):
    if not hashes:
        return sha256_text("")

    level = hashes[:]
    while len(level) > 1:
        next_level = []
        for i in range(0, len(level), 2):
            left = level[i]
            right = level[i + 1] if i + 1 < len(level) else left
            next_level.append(sha256_text(left + right))
        level = next_level

    return level[0]


def calc_block_hash(index, timestamp, transactions, merkle_root_value, previous_hash, nonce):
    payload = {
        "index": index,
        "timestamp": timestamp,
        "transactions": transactions,
        "merkle_root": merkle_root_value,
        "previous_hash": previous_hash,
        "nonce": nonce,
    }
    return sha256_text(json.dumps(payload, sort_keys=True))


def mine_block(index, transactions, previous_hash):
    timestamp = int(time.time())
    tx_hashes = [sha256_text(json.dumps(tx, sort_keys=True)) for tx in transactions]
    root = merkle_root(tx_hashes)
    nonce = 0
    prefix = "0" * POW_DIFFICULTY

    while True:
        block_hash = calc_block_hash(index, timestamp, transactions, root, previous_hash, nonce)
        if block_hash.startswith(prefix):
            break
        nonce += 1

    return {
        "index": index,
        "timestamp": timestamp,
        "transactions": transactions,
        "merkle_root": root,
        "previous_hash": previous_hash,
        "nonce": nonce,
        "hash": block_hash,
    }


def create_genesis_block():
    timestamp = int(time.time())
    return {
        "index": 0,
        "timestamp": timestamp,
        "transactions": [],
        "merkle_root": sha256_text(""),
        "previous_hash": "0",
        "nonce": 0,
        "hash": sha256_text(f"GENESIS-{timestamp}"),
    }


def save_sim_chain():
    payload = {
        "chain": SIM_BLOCKCHAIN,
        "pending": PENDING_TRANSACTIONS,
        "difficulty": POW_DIFFICULTY,
        "capacity": BLOCK_TX_CAPACITY,
    }
    try:
        with open(SIM_CHAIN_FILE, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
    except Exception as exc:
        print("SAVE CHAIN ERROR:", exc)


def load_sim_chain():
    global SIM_BLOCKCHAIN, PENDING_TRANSACTIONS

    if os.path.exists(SIM_CHAIN_FILE):
        try:
            with open(SIM_CHAIN_FILE, "r", encoding="utf-8") as f:
                payload = json.load(f)
            SIM_BLOCKCHAIN = payload.get("chain", [])
            PENDING_TRANSACTIONS = payload.get("pending", [])
        except Exception as exc:
            print("LOAD CHAIN ERROR:", exc)
            SIM_BLOCKCHAIN = []
            PENDING_TRANSACTIONS = []

    if not SIM_BLOCKCHAIN:
        SIM_BLOCKCHAIN = [create_genesis_block()]
        PENDING_TRANSACTIONS = []
        save_sim_chain()


def queue_transaction(tx_data):
    PENDING_TRANSACTIONS.append(tx_data)


def mine_pending_transactions(force=False):
    if not PENDING_TRANSACTIONS:
        return None

    if not force and len(PENDING_TRANSACTIONS) < BLOCK_TX_CAPACITY:
        return None

    if force:
        chunk = PENDING_TRANSACTIONS[:]
        PENDING_TRANSACTIONS.clear()
    else:
        chunk = PENDING_TRANSACTIONS[:BLOCK_TX_CAPACITY]
        del PENDING_TRANSACTIONS[:BLOCK_TX_CAPACITY]

    previous_hash = SIM_BLOCKCHAIN[-1]["hash"]
    index = SIM_BLOCKCHAIN[-1]["index"] + 1
    block = mine_block(index=index, transactions=chunk, previous_hash=previous_hash)
    SIM_BLOCKCHAIN.append(block)
    save_sim_chain()
    return block


def count_model_store_transactions():
    total = 0
    for block in SIM_BLOCKCHAIN:
        for tx in block.get("transactions", []):
            if tx.get("type") == "MODEL_STORE":
                total += 1
    return total


def backfill_sim_chain_from_contract():
    """Populate simulated chain from existing Ganache records after restart."""
    try:
        contract_count = get_record_count()
    except Exception as exc:
        print("BACKFILL COUNT ERROR:", exc)
        return

    existing_store_txs = count_model_store_transactions()
    if contract_count <= existing_store_txs:
        return

    for index in range(existing_store_txs, contract_count):
        row = contract.functions.records(index).call()
        tx_entry = {
            "type": "MODEL_STORE",
            "source": "BACKFILL",
            "version": index + 1,
            "dataset_hash": row[0],
            "model_hash": row[1],
            "accuracy": str(row[2]),
            "user": row[4],
            "created_at": int(row[3]),
        }
        queue_transaction(tx_entry)

    while len(PENDING_TRANSACTIONS) >= BLOCK_TX_CAPACITY:
        mine_pending_transactions(force=False)
    if PENDING_TRANSACTIONS:
        mine_pending_transactions(force=True)


# ---------------- CONNECT TO GANACHE ----------------
GANACHE_URL = "http://127.0.0.1:7545"
w3 = Web3(Web3.HTTPProvider(GANACHE_URL))

if w3.is_connected():
    print("Connected to Ganache")
else:
    print("Connection failed")
    raise SystemExit(1)

# ---------------- CHECK ACCOUNTS ----------------
accounts = w3.eth.accounts
if not accounts:
    print("No accounts found")
    raise SystemExit(1)

account = accounts[0]
print("Using account:", account)

# ---------------- CONTRACT DETAILS ----------------
contract_address = "0xc9bCA0230F9Ecf3659C8276b2b0B07dD37866184"
abi = [
    {
        "inputs": [
            {"internalType": "string", "name": "_datasetHash", "type": "string"},
            {"internalType": "string", "name": "_modelHash", "type": "string"},
            {"internalType": "string", "name": "_accuracy", "type": "string"},
        ],
        "name": "storeRecord",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [{"internalType": "uint256", "name": "index", "type": "uint256"}],
        "name": "getRecord",
        "outputs": [
            {"internalType": "string", "type": "string"},
            {"internalType": "string", "type": "string"},
            {"internalType": "string", "type": "string"},
            {"internalType": "uint256", "type": "uint256"},
            {"internalType": "address", "type": "address"},
        ],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "getRecordCount",
        "outputs": [{"internalType": "uint256", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [{"internalType": "uint256", "type": "uint256"}],
        "name": "records",
        "outputs": [
            {"internalType": "string", "name": "datasetHash", "type": "string"},
            {"internalType": "string", "name": "modelHash", "type": "string"},
            {"internalType": "string", "name": "accuracy", "type": "string"},
            {"internalType": "uint256", "name": "timestamp", "type": "uint256"},
            {"internalType": "address", "name": "user", "type": "address"},
        ],
        "stateMutability": "view",
        "type": "function",
    },
]
contract = w3.eth.contract(address=contract_address, abi=abi)
load_sim_chain()
backfill_sim_chain_from_contract()


@app.route("/")
def home():
    return "Backend is running"


@app.route("/upload", methods=["POST"])
def upload_files():
    try:
        model_file = request.files.get("model")
        dataset_file = request.files.get("dataset")

        if not model_file or not dataset_file:
            return jsonify({"error": "Missing files"}), 400

        model_bytes = model_file.read()
        dataset_bytes = dataset_file.read()

        model_hash = hashlib.sha256(model_bytes).hexdigest()
        dataset_hash = hashlib.sha256(dataset_bytes).hexdigest()

        model_file.seek(0)
        dataset_file.seek(0)

        model_path = os.path.join(UPLOAD_MODEL_DIR, f"{model_hash}.pkl")
        dataset_path = os.path.join(UPLOAD_DATASET_DIR, f"{dataset_hash}.csv")

        model_file.save(model_path)
        dataset_file.save(dataset_path)

        return jsonify(
            {
                "status": "uploaded",
                "model_hash": model_hash,
                "dataset_hash": dataset_hash,
            }
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/store", methods=["POST"])
def store():
    data = request.json
    if not data:
        return jsonify({"error": "No data received"}), 400

    required_fields = ["dataset_hash", "model_hash", "accuracy"]
    for field in required_fields:
        if field not in data:
            return jsonify({"error": f"Missing field: {field}"}), 400

    try:
        tx = contract.functions.storeRecord(
            data["dataset_hash"],
            data["model_hash"],
            data["accuracy"],
        ).transact({"from": account, "gas": 3000000})
        tx_hash = tx.hex()
        tx_entry = {
            "type": "MODEL_STORE",
            "tx_hash": tx_hash,
            "dataset_hash": data["dataset_hash"],
            "model_hash": data["model_hash"],
            "accuracy": str(data["accuracy"]),
            "user": account,
            "created_at": int(time.time()),
        }
        queue_transaction(tx_entry)
        mined_block = mine_pending_transactions(force=False)

        return jsonify(
            {
                "status": "stored",
                "tx_hash": tx_hash,
                "pending_transactions": len(PENDING_TRANSACTIONS),
                "mined_block": mined_block["index"] if mined_block else None,
            }
        )
    except Exception as exc:
        print("STORE ERROR:", str(exc))
        return jsonify({"status": "error", "message": str(exc)}), 500


@app.route("/records", methods=["GET"])
def get_all_records():
    try:
        count = get_record_count()
        records_list = []
        previous_dataset_hash = None

        for index in range(count):
            record = build_record(index, previous_dataset_hash=previous_dataset_hash)
            records_list.append(record)
            previous_dataset_hash = record["dataset_hash"]

        return jsonify(records_list)
    except Exception as exc:
        print("FETCH ERROR:", str(exc))
        return jsonify({"error": str(exc)}), 500


@app.route("/blocks", methods=["GET"])
def get_blocks():
    detect_model_file_deletions()
    chain_with_status = copy.deepcopy(SIM_BLOCKCHAIN)
    for block in chain_with_status:
        for tx in block.get("transactions", []):
            tx_type = tx.get("type")
            if tx_type in {"MODEL_STORE", "ROLLBACK"}:
                status, reason = get_file_status(tx.get("model_hash"), tx.get("source"))
                tx["status"] = status
                tx["reason"] = reason
            else:
                tx["status"] = "VALID"
                tx["reason"] = "Transaction verified"

    return jsonify(
        {
            "chain": chain_with_status,
            "pending": PENDING_TRANSACTIONS,
            "difficulty": POW_DIFFICULTY,
            "capacity": BLOCK_TX_CAPACITY,
            "active_model_version": ACTIVE_MODEL_VERSION,
        }
    )


@app.route("/events", methods=["GET"])
def get_events():
    detect_model_file_deletions()
    return jsonify({"events": list(reversed(INTEGRITY_EVENTS))})


@app.route("/mine", methods=["GET", "POST"])
def mine_now():
    mined_block = mine_pending_transactions(force=True)
    if not mined_block:
        return jsonify({"status": "idle", "message": "No pending transactions to mine"})

    return jsonify({"status": "mined", "block": mined_block})


@app.route("/latest", methods=["GET"])
def get_latest():
    try:
        count = get_record_count()
        if count == 0:
            return jsonify({"message": "No records yet"})

        previous_dataset_hash = None
        if count > 1:
            previous_dataset_hash = contract.functions.records(count - 2).call()[0]

        return jsonify(build_record(count - 1, previous_dataset_hash=previous_dataset_hash))
    except Exception as exc:
        print("LATEST ERROR:", str(exc))
        return jsonify({"error": str(exc)}), 500


@app.route("/record/<int:index>", methods=["GET"])
def get_record(index):
    try:
        is_valid, count = ensure_valid_index(index)
        if not is_valid:
            return jsonify({"error": "Invalid index", "count": count}), 400

        previous_dataset_hash = None
        if index > 0:
            previous_dataset_hash = contract.functions.records(index - 1).call()[0]

        return jsonify(build_record(index, previous_dataset_hash=previous_dataset_hash))
    except Exception as exc:
        print("RECORD ERROR:", str(exc))
        return jsonify({"error": str(exc)}), 500


@app.route("/verify/<int:version>", methods=["GET"])
def verify_again(version):
    index = version - 1
    is_valid, count = ensure_valid_index(index)
    if not is_valid:
        return jsonify({"error": "Invalid version", "count": count}), 400

    previous_dataset_hash = None
    if index > 0:
        previous_dataset_hash = contract.functions.records(index - 1).call()[0]
    record = build_record(index, previous_dataset_hash=previous_dataset_hash)

    return jsonify(
        {
            "status": "verified",
            "version": version,
            "record_status": record["status"],
            "reason": record["reason"],
        }
    )


@app.route("/recompute/<int:version>", methods=["GET"])
def recompute_hash(version):
    index = version - 1
    is_valid, count = ensure_valid_index(index)
    if not is_valid:
        return jsonify({"error": "Invalid version", "count": count}), 400

    record = contract.functions.records(index).call()
    blockchain_hash = record[1]
    current_hash = get_model_hash_from_file(blockchain_hash)
    if current_hash is None:
        return jsonify({"status": "missing", "message": "Model file not found locally"}), 404

    return jsonify(
        {
            "status": "recomputed",
            "version": version,
            "blockchain_hash": blockchain_hash,
            "current_hash": current_hash,
            "matches_chain": current_hash == blockchain_hash,
        }
    )


@app.route("/trust/<int:version>", methods=["GET", "POST"])
def mark_trusted(version):
    index = version - 1
    is_valid, count = ensure_valid_index(index)
    if not is_valid:
        return jsonify({"error": "Invalid version", "count": count}), 400

    MANUALLY_TRUSTED.add(version)
    return jsonify({"status": "trusted", "version": version})


@app.route("/rollback/<int:index>", methods=["GET"])
def rollback(index):
    global ACTIVE_MODEL_VERSION

    try:
        is_valid, count = ensure_valid_index(index)
        if not is_valid:
            return jsonify({"error": "Invalid index", "count": count}), 400

        row = contract.functions.records(index).call()
        dataset_hash = row[0]
        blockchain_hash = row[1]
        current_hash = get_model_hash_from_file(blockchain_hash)

        if current_hash is None:
            return (
                jsonify(
                    {
                        "status": "MISSING",
                        "message": "Model file deleted but exists in blockchain",
                        "model_hash": blockchain_hash,
                    }
                ),
                404,
            )

        if current_hash != blockchain_hash:
            return (
                jsonify(
                    {
                        "status": "TAMPERED",
                        "message": "Model file modified after storing",
                        "expected_hash": blockchain_hash,
                        "current_hash": current_hash,
                    }
                ),
                400,
            )

        model_path = os.path.join(MODEL_DIR, f"{blockchain_hash}.pkl")
        joblib.load(model_path)
        ACTIVE_MODEL_VERSION = index + 1

        rollback_tx = {
            "type": "ROLLBACK",
            "target_version": index + 1,
            "model_hash": blockchain_hash,
            "dataset_hash": dataset_hash,
            "user": account,
            "created_at": int(time.time()),
        }
        queue_transaction(rollback_tx)
        mined_block = mine_pending_transactions(force=True)

        return jsonify(
            {
                "status": "rollback_success",
                "version": index + 1,
                "model_hash": blockchain_hash,
                "dataset_hash": dataset_hash,
                "active_model_version": ACTIVE_MODEL_VERSION,
                "rollback_block": mined_block["index"] if mined_block else None,
            }
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


if __name__ == "__main__":
    public_url = ngrok.connect(5000)
    print("Ngrok URL:", public_url)
    app.run(port=5000, debug=False, use_reloader=False)
