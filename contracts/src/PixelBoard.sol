// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  PixelBoard
/// @notice A shared 64x64 canvas that lives fully onchain (think r/place).
///         Anyone can paint one pixel per transaction and then waits `cooldown` seconds.
///         No tokens, no fees, no owner: the contract only remembers colors.
///
/// @dev    Palette (index -> color) used by the frontend. Index 0 is the blank canvas.
///          0 #FFFFFF   1 #C9CED6   2 #7A808A   3 #1B1D22
///          4 #FF9EC7   5 #E8343A   6 #FF8A1F   7 #8C5A35
///          8 #FFD42A   9 #9BE22D  10 #22B14C  11 #2CD4D9
///         12 #3B82F6  13 #2335B8  14 #B967FF  15 #7A1FA2
contract PixelBoard {
    uint16 public constant WIDTH = 64;
    uint16 public constant HEIGHT = 64;
    uint8 public constant PALETTE_SIZE = 16;

    /// @notice Seconds an address must wait between two pixels. Set once at deploy, never changes.
    uint256 public immutable cooldown;

    /// @dev One byte per pixel = palette index. Pixel (x, y) is stored at index y * WIDTH + x.
    bytes private _pixels;

    /// @notice Who painted each pixel last (pixel index => address).
    mapping(uint256 => address) public lastPainter;
    /// @notice When an address painted last (unix timestamp, 0 = never).
    mapping(address => uint256) public lastPaintedAt;
    /// @notice How many pixels an address has painted in total.
    mapping(address => uint256) public paintCount;

    /// @notice Pixels painted by everyone, ever.
    uint256 public totalPainted;
    /// @notice Number of distinct addresses that painted at least once.
    uint256 public totalPainters;

    event PixelPainted(address indexed painter, uint16 x, uint16 y, uint8 color);

    error OutOfBounds(uint16 x, uint16 y);
    error InvalidColor(uint8 color);
    error CooldownActive(uint256 readyAt);

    constructor(uint256 cooldown_) {
        cooldown = cooldown_;
        _pixels = new bytes(uint256(WIDTH) * HEIGHT);
    }

    /// @notice Paint pixel (x, y) with palette color `color`.
    function paint(uint16 x, uint16 y, uint8 color) external {
        if (x >= WIDTH || y >= HEIGHT) revert OutOfBounds(x, y);
        if (color >= PALETTE_SIZE) revert InvalidColor(color);

        uint256 readyAt = nextPaintAt(msg.sender);
        // A few seconds of timestamp drift don't matter for a cooldown, so the lint warning is safe to ignore.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < readyAt) revert CooldownActive(readyAt);

        uint256 index = uint256(y) * WIDTH + x;
        _pixels[index] = bytes1(color);
        lastPainter[index] = msg.sender;
        lastPaintedAt[msg.sender] = block.timestamp;

        if (paintCount[msg.sender] == 0) totalPainters++;
        paintCount[msg.sender]++;
        totalPainted++;

        emit PixelPainted(msg.sender, x, y, color);
    }

    /// @notice The whole board in one call: WIDTH * HEIGHT bytes, row by row, each byte = palette index.
    function getBoard() external view returns (bytes memory) {
        return _pixels;
    }

    /// @notice Color and last painter of one pixel (painter is address(0) if nobody painted it yet).
    function getPixel(uint16 x, uint16 y) external view returns (uint8 color, address painter) {
        if (x >= WIDTH || y >= HEIGHT) revert OutOfBounds(x, y);
        uint256 index = uint256(y) * WIDTH + x;
        return (uint8(_pixels[index]), lastPainter[index]);
    }

    /// @notice Timestamp from which `user` may paint again (0 = never painted, can paint right now).
    function nextPaintAt(address user) public view returns (uint256) {
        uint256 last = lastPaintedAt[user];
        return last == 0 ? 0 : last + cooldown;
    }
}
