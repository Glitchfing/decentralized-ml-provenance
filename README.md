# Decentralized ML Provenance

A blockchain-based machine learning provenance and integrity platform for tracking ML models and datasets, recording their provenance, and detecting unauthorized changes.

## Overview

Machine learning workflows often involve multiple versions of datasets and trained models. Once a model is distributed or reused, it can become difficult to determine whether the underlying model or dataset has been modified.

This project addresses that problem by combining:

- SHA-256 hashing
- Blockchain-based provenance records
- Solidity smart contracts
- Ganache
- Web3
- A simulated blockchain layer
- A web-based monitoring dashboard

The system records dataset hashes, model hashes, model accuracy, timestamps, and blockchain transaction information. These records can then be used to verify whether a model remains consistent with its registered provenance.

## Key Features

###  Model & Dataset Integrity

Uploaded model and dataset files are hashed using SHA-256.

The generated hashes are used as unique integrity fingerprints for the files.

###  Blockchain Provenance

Model provenance information is recorded through a Solidity smart contract.

Stored information includes:

- Dataset hash
- Model hash
- Model accuracy
- Timestamp
- Blockchain user/address

###  Integrity Verification

The platform compares the current model file hash against its recorded blockchain hash.

It can identify states such as:

- `VALID` — model integrity verified
- `TAMPERED` — hash mismatch detected
- `MISSING` — model or blockchain record is unavailable
- `AT_RISK` — associated dataset has changed

###  Blockchain Visualization

The backend maintains a simulated blockchain representation containing:

- Blocks
- Transactions
- Merkle roots
- Previous block hashes
- Nonces
- Block hashes
- Pending transactions

The frontend visualizes the chain and checks links between blocks for integrity problems.

###  Monitoring Dashboard

The frontend dashboard provides:

- Model provenance records
- Blockchain blocks
- Transaction details
- Chain integrity status
- Integrity events
- Model accuracy history
- Risk/status visualization
- Model verification

###  Model Version & Rollback Support

The system maintains model versions and provides functionality for tracking and rolling back model states when required.

## Architecture

```text
                    ┌─────────────────────────┐
                    │       Frontend          │
                    │                         │
                    │  HTML / CSS / JavaScript│
                    │  Dashboard & Charts      │
                    └────────────┬────────────┘
                                 │
                                 │ REST API
                                 ▼
                    ┌─────────────────────────┐
                    │        Backend          │
                    │                         │
                    │ Flask + Python           │
                    │ SHA-256 Hashing          │
                    │ Integrity Verification  │
                    │ Provenance Management   │
                    └────────────┬────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
                    ▼                         ▼
          ┌──────────────────┐       ┌──────────────────┐
          │ Solidity Contract│       │ Simulated Chain  │
          │                  │       │                  │
          │ Provenance       │       │ Blocks           │
          │ Records          │       │ Transactions     │
          └────────┬─────────┘       │ Merkle Roots     │
                   │                 │ Integrity        │
                   ▼                 └──────────────────┘
          ┌──────────────────┐
          │     Ganache      │
          │ Local Blockchain │
          └──────────────────┘
