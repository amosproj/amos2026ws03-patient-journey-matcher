from abc import ABC, abstractmethod
from collections.abc import Sequence

from crawler.models import SourceName


class LinkExtractor(ABC):
    """Finds the records that collected records cite: the architecture's link extractor.

    It only returns IDs. The request queue rules in `crawler.frontier` decide which of
    them are fetched.
    """

    source: SourceName

    @abstractmethod
    def cited_ids(self, native_ids: Sequence[str]) -> dict[str, list[str]]:
        """Map each citing native ID to the native IDs it cites in the same source.

        Citing IDs without references map to an empty list.
        """
