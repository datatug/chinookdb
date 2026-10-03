# Licence: MIT (https://github.com/datatug/chinookdb/blob/main/LICENSE).
# The model restates the schema of the Chinook Database, Copyright (c) 2008-2024
# Luis Rocha, MIT (https://github.com/lerocha/chinook-database/blob/master/LICENSE.md),
# so that notice applies to it too. The meaning file chinook.meaning.yaml is CC0-1.0.
#
# Chinook sample database: storage-neutral data model (ModelSpec 1.0-draft).
#
# Module short name: chinook (references use modelspec:///chinook.<Entity>).
# Source of the structure: the pinned upstream SQLite fixture
# (data-source/Chinook_Sqlite.sqlite). Entity and property names are the
# upstream table and column names, so each property matches one published
# column one to one. scripts/test-model.mjs fails when this file and the
# published data disagree.
#
# Reading notes:
# - A property with `entity = "X"` is a reference to an X record. It holds
#   X's key value (for example Album.ArtistId holds an Artist.ArtistId).
# - NVARCHAR(n) columns are `string` with `max_len = n`.
# - NUMERIC(10,2) columns are `decimal`; ModelSpec has no precision or scale
#   attribute, so "10 digits, 2 after the point" is recorded here only.
# - DATETIME columns are `datetime`. Every Chinook value has a midnight time
#   part ("2021-01-01 00:00:00"); the model keeps the stored type.
# - Meaning (what a column is for, synonyms, units, labels in other languages)
#   lives in chinook.meaning.yaml, not here.

# A recording artist or band.
entity "Artist" {
  key = ["ArtistId"]

  property "ArtistId" {
    type     = "int"
    required = true
  }

  property "Name" {
    type    = "string"
    max_len = 120
  }
}

# An album released by one artist.
entity "Album" {
  key = ["AlbumId"]

  property "AlbumId" {
    type     = "int"
    required = true
  }

  property "Title" {
    type     = "string"
    required = true
    max_len  = 160
  }

  property "ArtistId" {
    entity   = "Artist"
    required = true
  }
}

# One audio or video track sold by the store.
entity "Track" {
  key = ["TrackId"]

  property "TrackId" {
    type     = "int"
    required = true
  }

  property "Name" {
    type     = "string"
    required = true
    max_len  = 200
  }

  property "AlbumId" {
    entity = "Album"
  }

  property "MediaTypeId" {
    entity   = "MediaType"
    required = true
  }

  property "GenreId" {
    entity = "Genre"
  }

  property "Composer" {
    type    = "string"
    max_len = 220
  }

  # Duration in milliseconds.
  property "Milliseconds" {
    type     = "int"
    required = true
  }

  # File size in bytes.
  property "Bytes" {
    type = "int"
  }

  # List price of one copy. NUMERIC(10,2).
  property "UnitPrice" {
    type     = "decimal"
    required = true
  }
}

# A music genre.
entity "Genre" {
  key = ["GenreId"]

  property "GenreId" {
    type     = "int"
    required = true
  }

  property "Name" {
    type    = "string"
    max_len = 120
  }
}

# A file format and encoding, such as "MPEG audio file".
entity "MediaType" {
  key = ["MediaTypeId"]

  property "MediaTypeId" {
    type     = "int"
    required = true
  }

  property "Name" {
    type    = "string"
    max_len = 120
  }
}

# A named list of tracks.
entity "Playlist" {
  key = ["PlaylistId"]

  property "PlaylistId" {
    type     = "int"
    required = true
  }

  property "Name" {
    type    = "string"
    max_len = 120
  }
}

# Membership of a track in a playlist: the many-to-many link between Playlist
# and Track. ModelSpec has no many-to-many construct; an association entity
# whose key is its two references is how the model says it.
entity "PlaylistTrack" {
  key = ["PlaylistId", "TrackId"]

  property "PlaylistId" {
    entity   = "Playlist"
    required = true
  }

  property "TrackId" {
    entity   = "Track"
    required = true
  }
}

# A person who buys from the store.
entity "Customer" {
  key = ["CustomerId"]

  property "CustomerId" {
    type     = "int"
    required = true
  }

  property "FirstName" {
    type     = "string"
    required = true
    max_len  = 40
  }

  property "LastName" {
    type     = "string"
    required = true
    max_len  = 20
  }

  property "Company" {
    type    = "string"
    max_len = 80
  }

  property "Address" {
    type    = "string"
    max_len = 70
  }

  property "City" {
    type    = "string"
    max_len = 40
  }

  property "State" {
    type    = "string"
    max_len = 40
  }

  # Country name as Chinook spells it ("USA", "Czech Republic").
  property "Country" {
    type    = "string"
    max_len = 40
  }

  property "PostalCode" {
    type    = "string"
    max_len = 10
  }

  property "Phone" {
    type    = "string"
    max_len = 24
  }

  property "Fax" {
    type    = "string"
    max_len = 24
  }

  property "Email" {
    type     = "string"
    required = true
    max_len  = 60
    format   = "email"
  }

  # The employee who supports this customer.
  property "SupportRepId" {
    entity = "Employee"
  }
}

# A store employee.
entity "Employee" {
  key = ["EmployeeId"]

  property "EmployeeId" {
    type     = "int"
    required = true
  }

  property "LastName" {
    type     = "string"
    required = true
    max_len  = 20
  }

  property "FirstName" {
    type     = "string"
    required = true
    max_len  = 20
  }

  property "Title" {
    type    = "string"
    max_len = 30
  }

  # The employee's manager: a reference to another Employee (self-reference).
  property "ReportsTo" {
    entity = "Employee"
  }

  property "BirthDate" {
    type = "datetime"
  }

  property "HireDate" {
    type = "datetime"
  }

  property "Address" {
    type    = "string"
    max_len = 70
  }

  property "City" {
    type    = "string"
    max_len = 40
  }

  property "State" {
    type    = "string"
    max_len = 40
  }

  property "Country" {
    type    = "string"
    max_len = 40
  }

  property "PostalCode" {
    type    = "string"
    max_len = 10
  }

  property "Phone" {
    type    = "string"
    max_len = 24
  }

  property "Fax" {
    type    = "string"
    max_len = 24
  }

  property "Email" {
    type    = "string"
    max_len = 60
    format  = "email"
  }
}

# One sale: an invoice raised for a customer.
entity "Invoice" {
  key = ["InvoiceId"]

  property "InvoiceId" {
    type     = "int"
    required = true
  }

  property "CustomerId" {
    entity   = "Customer"
    required = true
  }

  property "InvoiceDate" {
    type     = "datetime"
    required = true
  }

  property "BillingAddress" {
    type    = "string"
    max_len = 70
  }

  property "BillingCity" {
    type    = "string"
    max_len = 40
  }

  property "BillingState" {
    type    = "string"
    max_len = 40
  }

  # Country name as Chinook spells it ("USA", "Czech Republic").
  property "BillingCountry" {
    type    = "string"
    max_len = 40
  }

  property "BillingPostalCode" {
    type    = "string"
    max_len = 10
  }

  # Amount charged. Equals the sum of UnitPrice x Quantity over the invoice's
  # lines. NUMERIC(10,2). The data names no currency.
  property "Total" {
    type     = "decimal"
    required = true
  }
}

# One track on an invoice.
entity "InvoiceLine" {
  key = ["InvoiceLineId"]

  property "InvoiceLineId" {
    type     = "int"
    required = true
  }

  property "InvoiceId" {
    entity   = "Invoice"
    required = true
  }

  property "TrackId" {
    entity   = "Track"
    required = true
  }

  # Price charged for one copy on this invoice. NUMERIC(10,2).
  property "UnitPrice" {
    type     = "decimal"
    required = true
  }

  property "Quantity" {
    type     = "int"
    required = true
  }
}
