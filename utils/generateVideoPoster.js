const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const os = require("os");

ffmpeg.setFfmpegPath(ffmpegPath);

module.exports.generateVideoPoster = (inputPath) => {
  return new Promise((resolve, reject) => {
    const posterPath = path.join(
      os.tmpdir(),
      `poster-${Date.now()}.jpg`
    );

    ffmpeg(inputPath)
      .screenshots({
        count: 1,
        timemarks: ["1"],
        filename: path.basename(posterPath),
        folder: path.dirname(posterPath),
        size: "640x?"
      })
      .on("end", () => resolve(posterPath))
      .on("error", reject);
  });
};
