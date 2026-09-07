// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Provenance {

    struct Record {
        string datasetHash;
        string modelHash;
        string accuracy;
        uint timestamp;
    }

    Record[] public records;

    function storeRecord(
        string memory _datasetHash,
        string memory _modelHash,
        string memory _accuracy
    ) public {
        records.push(Record(
            _datasetHash,
            _modelHash,
            _accuracy,
            block.timestamp
        ));
    }

    function getRecord(uint index) public view returns (
        string memory, string memory, string memory, uint
    ) {
        Record memory r = records[index];
        return (r.datasetHash, r.modelHash, r.accuracy, r.timestamp);
    }
}