-- Chinook MediaType table
-- Generated from https://github.com/lerocha/chinook-database@7f67772503d71ba90f19283c38e93923addb43fa

CREATE TABLE [MediaType] (
  [MediaTypeId] INTEGER NOT NULL PRIMARY KEY,
  [Name] NVARCHAR(120)
);

INSERT INTO [MediaType] ([MediaTypeId], [Name]) VALUES (1, 'MPEG audio file');
INSERT INTO [MediaType] ([MediaTypeId], [Name]) VALUES (2, 'Protected AAC audio file');
INSERT INTO [MediaType] ([MediaTypeId], [Name]) VALUES (3, 'Protected MPEG-4 video file');
INSERT INTO [MediaType] ([MediaTypeId], [Name]) VALUES (4, 'Purchased AAC audio file');
INSERT INTO [MediaType] ([MediaTypeId], [Name]) VALUES (5, 'AAC audio file');
