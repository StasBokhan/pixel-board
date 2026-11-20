// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PixelBoard} from "../src/PixelBoard.sol";

/// Usage (see README):
///   COOLDOWN=30 forge script script/Deploy.s.sol --rpc-url robinhood_testnet --account deployer --broadcast
contract Deploy is Script {
    function run() external returns (PixelBoard board) {
        uint256 cooldown = vm.envOr("COOLDOWN", uint256(30));

        vm.startBroadcast();
        board = new PixelBoard(cooldown);
        vm.stopBroadcast();

        console.log("PixelBoard deployed at:", address(board));
        console.log("Cooldown (seconds):", cooldown);
    }
}
