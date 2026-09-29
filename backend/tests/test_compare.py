from services.text_compare import align_words, normalize_arabic

def test_normalize():
    assert normalize_arabic("إِيَّاكَ") == "اياك"

def test_exact():
    items, score = align_words("الحمد لله رب العالمين", "الحمد لله رب العالمين")
    assert score == 100
    assert all(x.status == "correct" for x in items)

def test_wrong_first_word():
    items, score = align_words("قل هو الله أحد", "كل هو الله أحد")
    assert score < 100
    assert items[0].status == "wrong"
