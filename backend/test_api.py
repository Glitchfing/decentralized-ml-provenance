import requests

data = {
    "dataset_hash": "dataset_123",
    "model_hash": "model_456",
    "accuracy": "0.95"
}

res = requests.post("http://127.0.0.1:5000/store", json=data)
print(res.json())