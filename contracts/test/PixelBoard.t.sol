// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PixelBoard} from "../src/PixelBoard.sol";

contract PixelBoardTest is Test {
    PixelBoard board;

    uint256 constant COOLDOWN = 30;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    event PixelPainted(address indexed painter, uint16 x, uint16 y, uint8 color);

    function setUp() public {
        vm.warp(1_700_000_000); // a realistic timestamp instead of Foundry's default 1
        board = new PixelBoard(COOLDOWN);
    }

    // --- Initial state ---------------------------------------------------------------------

    function test_BoardStartsBlank() public view {
        bytes memory pixels = board.getBoard();
        assertEq(pixels.length, 64 * 64);
        for (uint256 i = 0; i < pixels.length; i++) {
            assertEq(uint8(pixels[i]), 0);
        }
        assertEq(board.totalPainted(), 0);
        assertEq(board.totalPainters(), 0);
        assertEq(board.cooldown(), COOLDOWN);
    }

    function test_NewPlayerCanPaintImmediately() public view {
        assertEq(board.nextPaintAt(alice), 0);
    }

    // --- Painting --------------------------------------------------------------------------

    function test_PaintStoresColorAndPainter() public {
        vm.prank(alice);
        board.paint(10, 20, 5);

        (uint8 color, address painter) = board.getPixel(10, 20);
        assertEq(color, 5);
        assertEq(painter, alice);
    }

    function test_PaintWritesTheRightByteOfTheBoard() public {
        vm.prank(alice);
        board.paint(63, 2, 9); // last column of the third row

        bytes memory pixels = board.getBoard();
        assertEq(uint8(pixels[2 * 64 + 63]), 9);
        // neighbours untouched
        assertEq(uint8(pixels[2 * 64 + 62]), 0);
        assertEq(uint8(pixels[3 * 64]), 0);
    }

    function test_PaintEmitsEvent() public {
        vm.expectEmit(true, false, false, true, address(board));
        emit PixelPainted(alice, 1, 2, 3);

        vm.prank(alice);
        board.paint(1, 2, 3);
    }

    function test_CornersArePaintable() public {
        address[4] memory players = [alice, bob, makeAddr("carol"), makeAddr("dave")];
        uint16[2][4] memory corners =
            [[uint16(0), uint16(0)], [uint16(63), uint16(0)], [uint16(0), uint16(63)], [uint16(63), uint16(63)]];
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(players[i]);
            board.paint(corners[i][0], corners[i][1], 15);
            (uint8 color,) = board.getPixel(corners[i][0], corners[i][1]);
            assertEq(color, 15);
        }
    }

    function test_OtherPlayerCanOverwrite() public {
        vm.prank(alice);
        board.paint(5, 5, 4);
        vm.prank(bob);
        board.paint(5, 5, 12);

        (uint8 color, address painter) = board.getPixel(5, 5);
        assertEq(color, 12);
        assertEq(painter, bob);
    }

    function test_StatsAreCounted() public {
        vm.prank(alice);
        board.paint(0, 0, 1);
        vm.warp(block.timestamp + COOLDOWN);
        vm.prank(alice);
        board.paint(1, 0, 1);
        vm.prank(bob);
        board.paint(2, 0, 1);

        assertEq(board.paintCount(alice), 2);
        assertEq(board.paintCount(bob), 1);
        assertEq(board.totalPainted(), 3);
        assertEq(board.totalPainters(), 2);
    }

    // --- Validation ------------------------------------------------------------------------

    function test_RevertWhen_XOutOfBounds() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PixelBoard.OutOfBounds.selector, uint16(64), uint16(0)));
        board.paint(64, 0, 1);
    }

    function test_RevertWhen_YOutOfBounds() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PixelBoard.OutOfBounds.selector, uint16(0), uint16(64)));
        board.paint(0, 64, 1);
    }

    function test_RevertWhen_ColorNotInPalette() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PixelBoard.InvalidColor.selector, uint8(16)));
        board.paint(0, 0, 16);
    }

    function test_RevertWhen_GetPixelOutOfBounds() public {
        vm.expectRevert(abi.encodeWithSelector(PixelBoard.OutOfBounds.selector, uint16(64), uint16(64)));
        board.getPixel(64, 64);
    }

    // --- Cooldown --------------------------------------------------------------------------

    function test_RevertWhen_CooldownActive() public {
        vm.prank(alice);
        board.paint(0, 0, 1);
        uint256 readyAt = block.timestamp + COOLDOWN;
        assertEq(board.nextPaintAt(alice), readyAt);

        vm.warp(readyAt - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PixelBoard.CooldownActive.selector, readyAt));
        board.paint(1, 1, 1);
    }

    function test_CanPaintAgainAfterCooldown() public {
        vm.prank(alice);
        board.paint(0, 0, 1);

        vm.warp(block.timestamp + COOLDOWN);
        vm.prank(alice);
        board.paint(1, 1, 2);

        (uint8 color,) = board.getPixel(1, 1);
        assertEq(color, 2);
    }

    function test_CooldownIsPerAddress() public {
        vm.prank(alice);
        board.paint(0, 0, 1);
        vm.prank(bob); // alice is on cooldown, bob is not
        board.paint(0, 0, 2);
    }

    function test_ZeroCooldownAllowsBackToBackPixels() public {
        PixelBoard fast = new PixelBoard(0);
        vm.startPrank(alice);
        fast.paint(0, 0, 1);
        fast.paint(1, 0, 2);
        fast.paint(2, 0, 3);
        vm.stopPrank();
        assertEq(fast.paintCount(alice), 3);
    }

    // --- Fuzz ------------------------------------------------------------------------------

    function testFuzz_PaintAnyValidPixel(address player, uint16 x, uint16 y, uint8 color) public {
        vm.assume(player != address(0));
        x = uint16(bound(x, 0, 63));
        y = uint16(bound(y, 0, 63));
        color = uint8(bound(color, 0, 15));

        vm.prank(player);
        board.paint(x, y, color);

        (uint8 stored, address painter) = board.getPixel(x, y);
        assertEq(stored, color);
        assertEq(painter, player);
        assertEq(uint8(board.getBoard()[uint256(y) * 64 + x]), color);
        assertEq(board.getBoard().length, 64 * 64);
    }

    function testFuzz_RevertWhen_InvalidInput(uint16 x, uint16 y, uint8 color) public {
        vm.assume(x >= 64 || y >= 64 || color >= 16);
        vm.prank(alice);
        vm.expectRevert();
        board.paint(x, y, color);
    }
}
