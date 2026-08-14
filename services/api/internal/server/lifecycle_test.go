package server

import "testing"

func TestValidateCompletedPartsRejectsInvalidSets(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		parts []uploadedPart
		want  int
	}{
		{name: "duplicate part", parts: []uploadedPart{{PartNumber: 1, ETag: "one"}, {PartNumber: 1, ETag: "again"}}, want: 2},
		{name: "gap", parts: []uploadedPart{{PartNumber: 1, ETag: "one"}, {PartNumber: 3, ETag: "three"}}, want: 2},
		{name: "blank etag", parts: []uploadedPart{{PartNumber: 1, ETag: " "}}, want: 1},
		{name: "unexpected extra part", parts: []uploadedPart{{PartNumber: 1, ETag: "one"}, {PartNumber: 2, ETag: "two"}}, want: 1},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if err := validateCompletedParts(test.parts, test.want); err == nil {
				t.Fatalf("invalid part set was accepted: %+v", test.parts)
			}
		})
	}
}
